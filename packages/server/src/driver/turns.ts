import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import type { AcpClient } from '../acp/client/index.js';
import type { Agent } from '../agents/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { PublishInput, Store } from '../store/index.js';
import {
  turnDir,
  writeTurnInput,
  writeTurnOutput,
  writeTurnResult,
} from './files.js';
import { parseTurnResult, repromptText, type TurnFormat } from './result.js';

export const MAX_REPROMPTS = 1;

export const TURN_EVENTS = {
  result: 'turn.result',
  missed: 'turn.missed',
  stopped: 'turn.stopped',
  failed: 'turn.failed',
} as const;

const STOPPING: ReadonlySet<StopReason> = new Set(['cancelled', 'refusal']);

export type TurnClient = Pick<AcpClient, 'prompt' | 'subscribe'>;

export interface TurnTarget {
  store: Store;
  client: TurnClient;
  agent: Pick<Agent, 'id'>;
  sessionId: string;
  turnsDir: string;
  ticketId?: string;
}

export interface TurnRecord {
  id: number;
  seq: number;
  dir: string;
  stopReason: StopReason;
  text: string;
}

export type TurnOutcome<T> =
  | { status: 'result'; result: T; turns: TurnRecord[] }
  | { status: 'missed'; error: string; turns: TurnRecord[] }
  | { status: 'stopped'; stopReason: StopReason; turns: TurnRecord[] };

interface StartedTurn {
  id: number;
  seq: number;
  dir: string;
}

const startTurn = (target: TurnTarget, input: string): Promise<StartedTurn> =>
  target.store.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; seq: number }>(
      `insert into turns (agent_id, ticket_id, seq, prompt)
       select $1::uuid, $2::uuid, coalesce(max(seq), 0) + 1, $3
       from turns where agent_id = $1::uuid
       returning id, seq`,
      [target.agent.id, target.ticketId ?? null, input],
    );
    const [row] = rows;
    if (!row) throw new Error(`no turn row for agent ${target.agent.id}`);
    const dir = turnDir(target.turnsDir, target.agent.id, row.seq);
    await tx.query('update turns set transcript_path = $2 where id = $1', [
      row.id,
      dir,
    ]);
    await tx.query(
      `update agents set status = 'working'
       where id = $1 and status in ('idle', 'working')`,
      [target.agent.id],
    );
    return { ...row, dir };
  });

interface TurnEnd {
  stopReason: StopReason | null;
  inputTokens: number;
  outputTokens: number;
}

const endTurn = (
  target: TurnTarget,
  turn: StartedTurn,
  end: TurnEnd,
): Promise<void> =>
  target.store.db.transaction(async (tx) => {
    await tx.query(
      `update turns
       set stop_reason = $2, input_tokens = $3, output_tokens = $4,
           ended_at = now()
       where id = $1`,
      [turn.id, end.stopReason, end.inputTokens, end.outputTokens],
    );
    await tx.query(
      `update agents set status = 'idle'
       where id = $1 and status = 'working'`,
      [target.agent.id],
    );
  });

const collectUpdates = (client: TurnClient, sessionId: string) => {
  const updates: SessionUpdate[] = [];
  const stop = client.subscribe((event) => {
    if (event.type === 'session_update' && event.sessionId === sessionId) {
      updates.push(event.update);
    }
  });
  return { updates, stop };
};

export const replyText = (updates: readonly SessionUpdate[]): string =>
  updates
    .flatMap((update) => {
      if (update.sessionUpdate !== 'agent_message_chunk') return [];
      if (update.content.type !== 'text') return [];
      return [update.content.text];
    })
    .join('');

const record = (
  target: TurnTarget,
  kind: string,
  payload: Record<string, unknown>,
) => {
  const event: PublishInput = { kind, agentId: target.agent.id, payload };
  if (target.ticketId) event.ticketId = target.ticketId;
  return target.store.publish(event);
};

const failTurn = async (
  target: TurnTarget,
  turn: StartedTurn,
  updates: readonly SessionUpdate[],
  err: unknown,
): Promise<void> => {
  try {
    await writeTurnOutput(turn.dir, replyText(updates), updates);
    await endTurn(target, turn, {
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    await record(target, TURN_EVENTS.failed, {
      seq: turn.seq,
      error: getErrorMessage(err),
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [err, cleanupError],
      `turn ${turn.seq} failed and could not be closed`,
    );
  }
};

export const runPrompt = async (
  target: TurnTarget,
  input: string,
): Promise<TurnRecord> => {
  const turn = await startTurn(target, input);
  const collected = collectUpdates(target.client, target.sessionId);
  try {
    await writeTurnInput(turn.dir, input);
    const response = await target.client.prompt(target.sessionId, input);
    collected.stop();
    const text = replyText(collected.updates);
    await writeTurnOutput(turn.dir, text, collected.updates);
    await endTurn(target, turn, {
      stopReason: response.stopReason,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    });
    return { ...turn, stopReason: response.stopReason, text };
  } catch (err) {
    collected.stop();
    await failTurn(target, turn, collected.updates, err);
    throw err;
  }
};

export const runTurn = async <T>(
  target: TurnTarget,
  input: string,
  format: TurnFormat<T>,
): Promise<TurnOutcome<T>> => {
  const turns: TurnRecord[] = [];
  let prompt = input;
  for (let reprompts = 0; ; reprompts += 1) {
    const turn = await runPrompt(target, prompt);
    turns.push(turn);
    const { seq, stopReason } = turn;
    if (STOPPING.has(stopReason)) {
      await record(target, TURN_EVENTS.stopped, { seq, stopReason });
      return { status: 'stopped', stopReason, turns };
    }
    const parsed = parseTurnResult(turn.text, format.schema);
    if (parsed.ok) {
      await writeTurnResult(turn.dir, parsed.value);
      await record(target, TURN_EVENTS.result, { seq, result: parsed.value });
      return { status: 'result', result: parsed.value, turns };
    }
    const reprompt = reprompts < MAX_REPROMPTS;
    await record(target, TURN_EVENTS.missed, {
      seq,
      error: parsed.error,
      reprompt,
    });
    if (!reprompt) return { status: 'missed', error: parsed.error, turns };
    prompt = repromptText(parsed.error, format.instructions);
  }
};
