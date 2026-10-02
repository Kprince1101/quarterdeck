import { readFile } from 'node:fs/promises';
import type { StopReason } from '@agentclientprotocol/sdk';
import type { AcpClient } from '../acp/client/index.js';
import { hasErrorCode } from '../lib/errors.js';
import { assertProjectSlug } from '../store/paths.js';
import { TurnInputMissingError } from './errors.js';
import { turnDir, turnFile } from './files.js';
import {
  DRIVER_TURN_FORMAT,
  parseTurnResult,
  type DriverTurnResult,
  type ParsedTurnResult,
} from './result.js';
import { collectUpdates, replyText } from './turns.js';

export const REPLAY_COMMAND = 'npx quarterdeck replay';

const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReplayClient = Pick<
  AcpClient,
  'newSession' | 'prompt' | 'subscribe'
>;

export interface ReplayChain {
  turnsDir: string;
  agentId: string;
  through: number;
}

export interface ReplayOptions extends ReplayChain {
  client: ReplayClient;
  cwd: string;
  onTurn?: (turn: ReplayTurn) => void;
}

export interface SavedTurn {
  seq: number;
  dir: string;
  input: string;
  output: string | null;
}

export interface ReplayTurn {
  seq: number;
  input: string;
  savedOutput: string | null;
  output: string;
  stopReason: StopReason;
  result: ParsedTurnResult<DriverTurnResult>;
}

export interface Replay {
  sessionId: string;
  turns: ReplayTurn[];
}

export interface ReplayCommandParts {
  project: string;
  agentId: string;
  through: number;
}

const assertAgentId = (agentId: string): string => {
  if (!AGENT_ID.test(agentId)) {
    throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`);
  }
  return agentId;
};

const assertThrough = (through: number): number => {
  if (!Number.isSafeInteger(through) || through < 1) {
    throw new RangeError(
      `A replay runs turns 1..n with n a positive integer, not ${through}`,
    );
  }
  return through;
};

const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
};

const readSavedTurn = async (
  chain: ReplayChain,
  seq: number,
): Promise<SavedTurn> => {
  const dir = turnDir(chain.turnsDir, chain.agentId, seq);
  const inputPath = turnFile(dir, 'input');
  const input = await readOptional(inputPath);
  if (input === null) {
    throw new TurnInputMissingError(chain.agentId, seq, inputPath);
  }
  const output = await readOptional(turnFile(dir, 'output'));
  return { seq, dir, input, output };
};

export const readTurnChain = async (
  chain: ReplayChain,
): Promise<SavedTurn[]> => {
  assertAgentId(chain.agentId);
  const through = assertThrough(chain.through);
  const turns: SavedTurn[] = [];
  for (let seq = 1; seq <= through; seq += 1) {
    turns.push(await readSavedTurn(chain, seq));
  }
  return turns;
};

const replayTurn = async (
  client: ReplayClient,
  sessionId: string,
  saved: SavedTurn,
): Promise<ReplayTurn> => {
  const collected = collectUpdates(client, sessionId);
  try {
    const response = await client.prompt(sessionId, saved.input);
    const output = replyText(collected.updates);
    return {
      seq: saved.seq,
      input: saved.input,
      savedOutput: saved.output,
      output,
      stopReason: response.stopReason,
      result: parseTurnResult(output, DRIVER_TURN_FORMAT.schema),
    };
  } finally {
    collected.stop();
  }
};

export const replayDriverChain = async (
  options: ReplayOptions,
): Promise<Replay> => {
  const saved = await readTurnChain(options);
  const { client } = options;
  const { sessionId } = await client.newSession({
    cwd: options.cwd,
    mcpServers: [],
  });
  const turns: ReplayTurn[] = [];
  for (const turn of saved) {
    const replayed = await replayTurn(client, sessionId, turn);
    turns.push(replayed);
    options.onTurn?.(replayed);
  }
  return { sessionId, turns };
};

export const replayCommand = (parts: ReplayCommandParts): string =>
  [
    REPLAY_COMMAND,
    assertProjectSlug(parts.project),
    assertAgentId(parts.agentId),
    String(assertThrough(parts.through)),
  ].join(' ');
