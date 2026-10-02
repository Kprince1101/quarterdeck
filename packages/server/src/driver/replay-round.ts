import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode } from '../lib/errors.js';
import { readBirth } from './birth-input.js';
import { turnDir, turnFile } from './files.js';

const AGENT_DIR =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEQ_DIR = /^\d+$/;

export interface RoundSession {
  agentId: string;
  driverName: string;
  round: number;
  firstSeq: number;
  lastSeq: number;
  bornAt: Date;
}

const subdirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return [];
    throw err;
  }
};

const readInput = async (
  path: string,
): Promise<{ text: string; mtime: Date } | null> => {
  try {
    const [text, info] = await Promise.all([
      readFile(path, 'utf8'),
      stat(path),
    ]);
    return { text, mtime: info.mtime };
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
};

const turnSeqs = async (turnsDir: string, agentId: string) =>
  (await subdirs(join(turnsDir, agentId)))
    .filter((name) => SEQ_DIR.test(name))
    .map(Number)
    .filter((seq) => seq > 0)
    .toSorted((a, b) => a - b);

const agentSessions = async (
  turnsDir: string,
  agentId: string,
): Promise<RoundSession[]> => {
  const sessions: RoundSession[] = [];
  let current: RoundSession | undefined;
  for (const seq of await turnSeqs(turnsDir, agentId)) {
    const path = turnFile(turnDir(turnsDir, agentId, seq), 'input');
    const input = await readInput(path);
    const birth = input && readBirth(input.text);
    if (input && birth) {
      current = {
        agentId,
        driverName: birth.name,
        round: birth.round,
        firstSeq: seq,
        lastSeq: seq,
        bornAt: input.mtime,
      };
      sessions.push(current);
    } else if (current) {
      current.lastSeq = seq;
    } else {
      return [];
    }
  }
  return sessions;
};

const roundSessionsOf = async (
  turnsDir: string,
  agentIds: readonly string[],
  round: number,
): Promise<RoundSession[]> => {
  const sessions = await Promise.all(
    agentIds
      .filter((agentId) => AGENT_DIR.test(agentId))
      .map((agentId) => agentSessions(turnsDir, agentId)),
  );
  return sessions
    .flat()
    .filter((session) => session.round === round)
    .toSorted(
      (a, b) =>
        a.bornAt.getTime() - b.bornAt.getTime() || a.firstSeq - b.firstSeq,
    );
};

export const findRoundSessions = async (
  turnsDir: string,
  round: number,
): Promise<RoundSession[]> =>
  roundSessionsOf(turnsDir, await subdirs(turnsDir), round);

export interface TurnSession {
  session: RoundSession;
  n: number;
  latest: boolean;
}

export type RoundAgents = (round: number) => Promise<readonly string[]>;

const sameSession = (a: RoundSession, b: RoundSession | undefined): boolean =>
  b !== undefined && a.agentId === b.agentId && a.firstSeq === b.firstSeq;

export const findTurnSession = async (
  turnsDir: string,
  agentId: string,
  seq: number,
  roundAgents: RoundAgents,
): Promise<TurnSession | null> => {
  const session = (await agentSessions(turnsDir, agentId)).find(
    (candidate) => candidate.firstSeq <= seq && seq <= candidate.lastSeq,
  );
  if (session === undefined) return null;
  const agentIds = new Set([agentId, ...(await roundAgents(session.round))]);
  const round = await roundSessionsOf(turnsDir, [...agentIds], session.round);
  return {
    session,
    n: seq - session.firstSeq + 1,
    latest: sameSession(session, round.at(-1)),
  };
};
