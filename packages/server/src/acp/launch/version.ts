import { spawn } from 'node:child_process';
import { getErrorMessage } from '../../lib/errors.js';
import { SPAWN_DETACHED, signalTree } from '../client/process-tree.js';
import type { AgentCommand } from '../client/types.js';

export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

export interface VersionProbe {
  version: string | null;
  error?: string;
}

export interface ProbeOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

const failed = (error: string): VersionProbe => ({ version: null, error });

const readOutput = (stdout: string, stderr: string): VersionProbe => {
  const version = firstLine(stdout) || firstLine(stderr);
  if (version) return { version };
  return failed('printed no version');
};

export const probeAgentVersion = (
  { command, args, cwd, env }: AgentCommand,
  { timeoutMs, signal }: ProbeOptions,
): Promise<VersionProbe> =>
  new Promise<VersionProbe>((resolve) => {
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

    const finish = (result: VersionProbe) => {
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

    child.once('error', (err) => finish(failed(getErrorMessage(err))));
    child.once('close', (code, exitSignal) => {
      if (code === 0) {
        finish(readOutput(stdout, stderr));
        return;
      }
      finish(failed(`exited with ${code ?? exitSignal}`));
    });
  });
