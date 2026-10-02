import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export type TreeSignal = 'SIGTERM' | 'SIGKILL';

const IS_WINDOWS = process.platform === 'win32';
const TREE_POLL_MS = 25;

export const SPAWN_DETACHED = !IS_WINDOWS;

const TASKKILL_FLAGS: Record<TreeSignal, string[]> = {
  SIGTERM: ['/T'],
  SIGKILL: ['/T', '/F'],
};

const treeTarget = (pid: number) => {
  if (IS_WINDOWS) return pid;
  return -pid;
};

const isMissingProcess = (err: unknown) =>
  err instanceof Error && 'code' in err && err.code === 'ESRCH';

const signalWindowsTree = (pid: number, signal: TreeSignal) => {
  spawn('taskkill', ['/pid', String(pid), ...TASKKILL_FLAGS[signal]], {
    stdio: 'ignore',
    windowsHide: true,
  }).on('error', () => undefined);
};

const signalProcessGroup = (pid: number, signal: TreeSignal) => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
};

export const signalTree = (pid: number, signal: TreeSignal) => {
  if (IS_WINDOWS) {
    signalWindowsTree(pid, signal);
    return;
  }
  signalProcessGroup(pid, signal);
};

export const isTreeAlive = (pid: number) => {
  try {
    process.kill(treeTarget(pid), 0);
    return true;
  } catch (err) {
    return !isMissingProcess(err);
  }
};

export const waitForTreeExit = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (isTreeAlive(pid) && Date.now() < deadline) {
    await sleep(TREE_POLL_MS);
  }
  return !isTreeAlive(pid);
};
