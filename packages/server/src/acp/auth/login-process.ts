import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { getErrorMessage, hasErrorCode } from '../../lib/errors.js';
import { SPAWN_DETACHED, signalTree } from '../client/process-tree.js';
import { childEnv, wholeEnv, withChildEnv } from '../env.js';
import { trackSignInPrompt, type PromptTracker } from './output.js';
import type { SignInOutcome, SignInRunOptions } from './types.js';

export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

const LAST_LINE_MAX = 200;

export interface LoginCommand {
  command: string;
  args: readonly string[];
  display: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  opensBrowser: boolean;
}

const readLines = (
  stream: Readable | null,
  tracker: PromptTracker,
  last: { line: string },
) => {
  if (!stream) return;
  createInterface({ input: stream }).on('line', (line) => {
    if (line.trim() !== '') last.line = line.trim().slice(0, LAST_LINE_MAX);
    tracker.line(line);
  });
};

const stopChild = (child: ChildProcess, detached: boolean) => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (detached) signalTree(child.pid, 'SIGKILL');
  else child.kill('SIGTERM');
};

const stdioFor = (tty: boolean): StdioOptions => {
  if (tty) return 'inherit';
  return ['ignore', 'pipe', 'pipe'];
};

const exitReason = (
  login: LoginCommand,
  code: number | null,
  signal: NodeJS.Signals | null,
  lastLine: string,
): string => {
  let how = `exited with ${code}`;
  if (code === null) how = `was stopped by ${signal}`;
  if (lastLine === '') return `${login.display} ${how}`;
  return `${login.display} ${how}: ${lastLine}`;
};

export const runLoginProcess = (
  login: LoginCommand,
  options: SignInRunOptions = {},
): Promise<SignInOutcome> =>
  new Promise<SignInOutcome>((resolve) => {
    const tracker = trackSignInPrompt({
      ...(options.onProgress && { onProgress: options.onProgress }),
      ...(!login.opensBrowser &&
        options.openUrl && { openUrl: options.openUrl }),
    });
    const fail = (reason: string): SignInOutcome => {
      tracker.report({
        ...tracker.current(),
        status: 'failed',
        message: reason,
      });
      return { ok: false, reason };
    };
    if (options.signal?.aborted) {
      resolve(fail(`${login.display} was cancelled`));
      return;
    }
    const tty = options.tty ?? false;
    const detached = !tty && SPAWN_DETACHED;
    const child = spawn(login.command, [...login.args], {
      cwd: login.cwd,
      env: childEnv(
        withChildEnv(wholeEnv(options.env), { set: login.env ?? {} }),
      ),
      stdio: stdioFor(tty),
      detached,
      windowsHide: true,
    });
    const last = { line: '' };
    readLines(child.stdout, tracker, last);
    readLines(child.stderr, tracker, last);

    let settled = false;
    const finish = (outcome: SignInOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const stop = (reason: string) => {
      stopChild(child, detached);
      finish(fail(reason));
    };
    const onAbort = () => stop(`${login.display} was cancelled`);
    const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    const timer = setTimeout(
      () => stop(`${login.display} did not finish within ${timeoutMs / 1000}s`),
      timeoutMs,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (err) => {
      if (hasErrorCode(err, 'ENOENT')) {
        finish(fail(`${login.command} is not installed`));
        return;
      }
      finish(fail(`${login.display} could not start: ${getErrorMessage(err)}`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        tracker.report({ ...tracker.current(), status: 'signed_in' });
        finish({ ok: true, via: login.display });
        return;
      }
      finish(fail(exitReason(login, code, signal, last.line)));
    });
  });
