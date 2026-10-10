import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  SPAWN_DETACHED,
  signalTree,
  stopTree,
} from '../acp/client/process-tree.js';
import { childEnv } from '../acp/env.js';
import { getErrorMessage } from '../lib/errors.js';
import type { HoldCommand } from './backend.js';
import { KeepAwakeError } from './errors.js';

export const KEEP_AWAKE_KILL_GRACE_MS = 2_000;

export interface HeldProcess {
  pid: number;
  startedAt: Date;
  exited: Promise<void>;
  stop: () => Promise<void>;
  stopNow: () => void;
}

export type SpawnHold = (command: HoldCommand) => Promise<HeldProcess>;

export const spawnHoldProcess: SpawnHold = async ({ command, args }) => {
  const child = spawn(command, args, {
    env: childEnv(),
    stdio: 'ignore',
    detached: SPAWN_DETACHED,
    windowsHide: true,
  });
  try {
    await once(child, 'spawn');
  } catch (err) {
    throw new KeepAwakeError(
      `Could not start ${command}: ${getErrorMessage(err)}`,
    );
  }
  child.on('error', () => undefined);
  const { pid } = child;
  if (pid === undefined) throw new KeepAwakeError(`${command} has no pid`);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  return {
    pid,
    startedAt: new Date(),
    exited,
    stop: async () => {
      await stopTree(pid, KEEP_AWAKE_KILL_GRACE_MS);
      await exited;
    },
    stopNow: () => signalTree(pid, 'SIGKILL'),
  };
};
