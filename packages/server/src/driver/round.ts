import type { AcpClient } from '../acp/client/index.js';
import {
  AGENT_COLUMNS,
  type Agent,
  type AgentStatus,
} from '../agents/index.js';
import { findAgent, firstRow, recordEvent } from '../agents/rows.js';
import type { BusHost } from '../bus/index.js';
import type { Store } from '../store/index.js';
import {
  buildBirthInput,
  readActiveNotebook,
  type NotebookEntry,
  type Round,
} from './birth-input.js';
import {
  NotADriverError,
  RoundEndedError,
  RoundNotFoundError,
} from './errors.js';
import { DRIVER_TURN_FORMAT, type DriverTurnResult } from './result.js';
import { runTurn, type TurnOutcome, type TurnTarget } from './turns.js';

export const ROUND_STARTED_EVENT = 'driver.round_started';

const ENDED: ReadonlySet<AgentStatus> = new Set(['ended', 'killed', 'retired']);

export type DriverClient = Pick<
  AcpClient,
  'newSession' | 'prompt' | 'subscribe'
>;

export interface DriverRoundOptions {
  store: Store;
  client: DriverClient;
  bus: Pick<BusHost, 'launch'>;
  agentId: string;
  roundId: string;
  cwd: string;
  charter: string;
  turnsDir: string;
}

export type DriverTurnOutcome = TurnOutcome<DriverTurnResult>;

export interface DriverRound {
  agent: Agent;
  round: Round;
  sessionId: string;
  notebook: readonly NotebookEntry[];
  birth: Promise<DriverTurnOutcome>;
  turn: (input: string) => Promise<DriverTurnOutcome>;
}

const findRound = async (store: Store, roundId: string): Promise<Round> => {
  const { rows } = await store.db.query<Round>(
    `select id, number, status, goal from rounds
     where id = $1 and project_id = $2`,
    [roundId, store.projectId],
  );
  const [round] = rows;
  if (!round) throw new RoundNotFoundError(roundId);
  if (round.status === 'ended')
    throw new RoundEndedError(round.id, round.number);
  return round;
};

const findDriver = async (store: Store, agentId: string): Promise<Agent> => {
  const agent = await findAgent(store, agentId);
  if (agent.role !== 'driver') {
    throw new NotADriverError(agentId, `its role is ${agent.role}`);
  }
  if (ENDED.has(agent.status)) {
    throw new NotADriverError(agentId, `it is ${agent.status}`);
  }
  return agent;
};

const attachRoundSession = (
  store: Store,
  agent: Agent,
  round: Round,
  sessionId: string,
  notebook: readonly NotebookEntry[],
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents
       set session_id = $2, round_id = $3,
           status = case when status = 'starting' then 'idle' else status end
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id, sessionId, round.id],
    );
    const attached = firstRow(rows, agent.id);
    await recordEvent(tx, attached, ROUND_STARTED_EVENT, {
      roundId: round.id,
      round: round.number,
      sessionId,
      notebook: notebook.map((entry) => entry.id),
    });
    return attached;
  });

const serialize = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
};

export const openDriverRound = async (
  options: DriverRoundOptions,
): Promise<DriverRound> => {
  const { store, client } = options;
  const round = await findRound(store, options.roundId);
  const driver = await findDriver(store, options.agentId);
  const bus = await options.bus.launch(driver.id);
  const { sessionId } = await client.newSession({
    cwd: options.cwd,
    mcpServers: [bus],
  });
  const notebook = await readActiveNotebook(store.db, store.projectId);
  const agent = await attachRoundSession(
    store,
    driver,
    round,
    sessionId,
    notebook,
  );
  const target: TurnTarget = {
    store,
    client,
    agent,
    sessionId,
    turnsDir: options.turnsDir,
  };
  const enqueue = serialize();
  const turn = (input: string) =>
    enqueue(() => runTurn(target, input, DRIVER_TURN_FORMAT));
  const birthInput = buildBirthInput({
    agent,
    round,
    charter: options.charter,
    notebook,
    instructions: DRIVER_TURN_FORMAT.instructions,
  });
  const birth = turn(birthInput);
  birth.catch(() => undefined);
  return { agent, round, sessionId, notebook, birth, turn };
};
