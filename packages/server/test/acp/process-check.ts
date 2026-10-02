import { spawnSync } from 'node:child_process';
import { expect, vi } from 'vitest';

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const expectAllExited = async (pids: readonly number[]) => {
  await vi.waitFor(() => {
    pids.forEach((pid) => expect(isAlive(pid)).toBe(false));
  });
};

export const markedProcesses = (marker: string): string[] =>
  spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => line.includes(marker));
