import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { recordAgentProcess } from '../../src/agents/index.js';
import type { Store } from '../../src/store/index.js';

export const TIMEOUT = 30_000;
export const GRACE_MS = 200;
export const IS_WINDOWS = process.platform === 'win32';

const SLEEP = 'setInterval(() => {}, 1000);';
const IGNORE_SIGTERM = "process.on('SIGTERM', () => {});";
const READY = "process.stdout.write('ready\\n');";

export interface Sleeper {
  pid: number;
  startedAt: Date;
  child: ChildProcess;
}

const sleepers: Sleeper[] = [];

export const startSleeper = async (
  options: { ignoreSigterm?: boolean } = {},
): Promise<Sleeper> => {
  const script = [options.ignoreSigterm && IGNORE_SIGTERM, READY, SLEEP]
    .filter(Boolean)
    .join(' ');
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await once(child.stdout ?? child, 'data');
  const sleeper = { pid: child.pid ?? 0, startedAt: new Date(), child };
  sleepers.push(sleeper);
  return sleeper;
};

export const stopSleepers = (): void => {
  for (const { pid } of sleepers.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      continue;
    }
  }
};

export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const exitOf = (
  sleeper: Sleeper,
): Promise<[number | null, NodeJS.Signals | null]> => {
  const { exitCode, signalCode } = sleeper.child;
  if (exitCode !== null || signalCode !== null)
    return Promise.resolve([exitCode, signalCode]);
  return once(sleeper.child, 'exit') as Promise<
    [number | null, NodeJS.Signals | null]
  >;
};

export const giveProcess = (
  store: Store,
  agentId: string,
  sleeper: Pick<Sleeper, 'pid' | 'startedAt'>,
): Promise<void> =>
  recordAgentProcess(store.db, agentId, {
    pid: sleeper.pid,
    startedAt: sleeper.startedAt,
  });

export const storedPid = async (
  store: Store,
  agentId: string,
): Promise<number | null> => {
  const { rows } = await store.db.query<{ pid: number | null }>(
    'select pid from agents where id = $1',
    [agentId],
  );
  return rows[0]?.pid ?? null;
};
