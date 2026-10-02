import { runCommand } from '../launch/run.js';
import { IS_WINDOWS, isTreeAlive, stopTree } from './process-tree.js';
import type { TreeStop } from './process-tree.js';

export const PROCESS_START_TOLERANCE_MS = 5_000;
const PS_TIMEOUT_MS = 5_000;
const NO_SUCH_PROCESS_EXIT = 1;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const LSTART =
  /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

export type OwnedTreeStop = TreeStop | 'unverified';

export interface RecordedProcess {
  pid: number;
  startedAt: Date;
}

export class ProcessCheckError extends Error {
  readonly pid: number;

  constructor(pid: number, reason: string) {
    super(`Could not check process ${pid}: ${reason}`);
    this.name = 'ProcessCheckError';
    this.pid = pid;
  }
}

export const parseProcessStart = (text: string): Date | null => {
  const match = LSTART.exec(text.trim());
  if (!match) return null;
  const [, month = '', day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex === -1) return null;
  return new Date(
    Number(year),
    monthIndex,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
};

export const processStartedAt = async (pid: number): Promise<Date | null> => {
  const result = await runCommand(
    {
      command: 'ps',
      args: ['-o', 'lstart=', '-p', String(pid)],
      env: { ...process.env, LC_ALL: 'C' },
    },
    { timeoutMs: PS_TIMEOUT_MS },
  );
  if (result.status === 'failed')
    throw new ProcessCheckError(pid, result.error);
  if (result.code === NO_SUCH_PROCESS_EXIT && result.stdout.trim() === '')
    return null;
  const started = parseProcessStart(result.stdout);
  if (started === null)
    throw new ProcessCheckError(
      pid,
      `ps said ${JSON.stringify(result.stdout)}`,
    );
  return started;
};

const isSameStart = (started: Date, recorded: Date): boolean =>
  Math.abs(started.getTime() - recorded.getTime()) <=
  PROCESS_START_TOLERANCE_MS;

export const isOwnTree = async (
  recorded: RecordedProcess,
): Promise<boolean> => {
  const started = await processStartedAt(recorded.pid);
  if (started === null) return isTreeAlive(recorded.pid);
  return isSameStart(started, recorded.startedAt);
};

const checkOwnTree = async (
  recorded: RecordedProcess,
): Promise<boolean | undefined> => {
  if (IS_WINDOWS) return undefined;
  try {
    return await isOwnTree(recorded);
  } catch (err) {
    if (err instanceof ProcessCheckError) return undefined;
    throw err;
  }
};

export const stopOwnTree = async (
  recorded: RecordedProcess,
  graceMs: number,
): Promise<OwnedTreeStop> => {
  const owned = await checkOwnTree(recorded);
  if (owned === undefined) return 'unverified';
  if (!owned) return 'gone';
  return stopTree(recorded.pid, graceMs);
};
