import type { AuthMethod } from '@agentclientprotocol/sdk';
import { getErrorMessage } from '../../lib/errors.js';
import { CANCELLED_PERMISSION } from '../client/permission-gate.js';
import { spawnAcpClient } from '../client/spawn.js';
import type { AcpClient, AgentCommand } from '../client/types.js';
import { wholeEnv, withChildEnv } from '../env.js';
import {
  SIGN_IN_TIMEOUT_MS,
  runLoginProcess,
  type LoginCommand,
} from './login-process.js';
import {
  authMethodIds,
  findAuthMethod,
  isTerminalAuthMethod,
  type TerminalAuthMethod,
} from './methods.js';
import { trackSignInPrompt, type PromptTracker } from './output.js';
import type { SignInOutcome, SignInRunOptions } from './types.js';

export const SIGN_IN_CLIENT_NAME = 'quarterdeck-signin';
export const SIGN_IN_CLIENT_VERSION = '0.0.0';

const STDERR_DRAIN_GUARD_MS = 5_000;

export interface AcpSignInTarget {
  displayName: string;
  methodId: string;
  agent: AgentCommand;
  invocation?: AgentCommand;
  opensBrowser: boolean;
  initializeTimeoutMs?: number;
}

const withShellEnv = (
  command: AgentCommand,
  env: NodeJS.ProcessEnv | undefined,
): AgentCommand => ({
  ...command,
  env: withChildEnv(command.env, wholeEnv(env)),
});

const terminalLogin = (
  target: AcpSignInTarget,
  method: TerminalAuthMethod,
): LoginCommand => {
  const invocation = target.invocation ?? target.agent;
  const args = [...invocation.args, ...(method.args ?? [])];
  const login: LoginCommand = {
    command: invocation.command,
    args,
    display: [invocation.command, ...args].join(' '),
    opensBrowser: target.opensBrowser,
  };
  if (invocation.cwd !== undefined) login.cwd = invocation.cwd;
  const env = { ...invocation.env?.set, ...method.env };
  if (Object.keys(env).length > 0) login.env = env;
  return login;
};

const withDeadline = async <T>(
  work: Promise<T>,
  label: string,
  { signal, timeoutMs = SIGN_IN_TIMEOUT_MS }: SignInRunOptions,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${label} did not finish within ${timeoutMs / 1000}s`),
        ),
      timeoutMs,
    );
    onAbort = () => reject(new Error(`${label} was cancelled`));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

interface StderrDrain {
  done: Promise<void>;
  closed: () => void;
}

const stderrDrain = (): StderrDrain => {
  let closed = () => {};
  const done = new Promise<void>((resolve) => {
    closed = resolve;
  });
  return { done, closed };
};

const drained = async (drain: StderrDrain): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STDERR_DRAIN_GUARD_MS);
  });
  try {
    await Promise.race([drain.done, stuck]);
  } finally {
    clearTimeout(timer);
  }
};

const connect = (
  target: AcpSignInTarget,
  tracker: PromptTracker,
  drain: StderrDrain,
  options: SignInRunOptions,
): Promise<AcpClient> =>
  spawnAcpClient(withShellEnv(target.agent, options.env), {
    clientName: SIGN_IN_CLIENT_NAME,
    clientVersion: SIGN_IN_CLIENT_VERSION,
    onPermissionRequest: () => Promise.resolve(CANCELLED_PERMISSION),
    onEvent: (event) => {
      if (event.type === 'stderr') tracker.line(event.line);
      if (event.type === 'stderr_closed') drain.closed();
    },
    ...(target.initializeTimeoutMs !== undefined && {
      initializeTimeoutMs: target.initializeTimeoutMs,
    }),
    ...(options.signal && { signal: options.signal }),
  });

const authenticate = async (
  client: AcpClient,
  method: AuthMethod,
  target: AcpSignInTarget,
  options: SignInRunOptions,
): Promise<SignInOutcome> => {
  await withDeadline(
    client.authenticate(method.id),
    `${target.displayName} sign-in`,
    options,
  );
  return { ok: true, via: `ACP authenticate ${method.id}` };
};

export const signInOverAcp = async (
  target: AcpSignInTarget,
  options: SignInRunOptions = {},
): Promise<SignInOutcome> => {
  const tracker = trackSignInPrompt({
    ...(options.onProgress && { onProgress: options.onProgress }),
    ...(!target.opensBrowser &&
      options.openUrl && { openUrl: options.openUrl }),
  });
  const fail = (reason: string): SignInOutcome => {
    tracker.report({ ...tracker.current(), status: 'failed', message: reason });
    return { ok: false, reason };
  };
  const drain = stderrDrain();
  let client: AcpClient;
  try {
    client = await connect(target, tracker, drain, options);
  } catch (err) {
    return fail(`${target.displayName} did not start: ${getErrorMessage(err)}`);
  }
  try {
    const method = findAuthMethod(client.agent.authMethods, target.methodId);
    if (!method) {
      return fail(
        `${target.displayName} does not offer the ${target.methodId} sign-in (it offers: ${authMethodIds(client.agent.authMethods)})`,
      );
    }
    if (isTerminalAuthMethod(method)) {
      await client.close();
      return await runLoginProcess(terminalLogin(target, method), options);
    }
    const outcome = await authenticate(client, method, target, options);
    await client.close();
    await drained(drain);
    tracker.report({ ...tracker.current(), status: 'signed_in' });
    return outcome;
  } catch (err) {
    return fail(
      `${target.displayName} sign-in failed: ${getErrorMessage(err)}`,
    );
  } finally {
    await client.close();
  }
};
