import { spawn } from 'node:child_process';
import { getErrorMessage, hasErrorCode } from '../../lib/errors.js';
import { SPAWN_DETACHED, signalTree } from '../client/process-tree.js';
import type { AgentCommand } from '../client/types.js';

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type CommandResult =
  | {
      status: 'exited';
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }
  | { status: 'failed'; error: string; notFound: boolean };

const failed = (error: string, notFound = false): CommandResult => ({
  status: 'failed',
  error,
  notFound,
});

export const runCommand = (
  { command, args, cwd, env }: AgentCommand,
  { timeoutMs, signal }: RunOptions,
): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve) => {
    if (signal?.aborted) {
      resolve(failed('aborted'));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: SPAWN_DETACHED,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    const finish = (result: CommandResult) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const stop = (reason: string) => {
      if (child.pid !== undefined) signalTree(child.pid, 'SIGKILL');
      finish(failed(reason));
    };
    const onAbort = () => stop('aborted');
    const timer = setTimeout(() => stop('timed out'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (err) =>
      finish(failed(getErrorMessage(err), hasErrorCode(err, 'ENOENT'))),
    );
    child.once('close', (code, exitSignal) => {
      finish({ status: 'exited', code, signal: exitSignal, stdout, stderr });
    });
  });
