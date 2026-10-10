import type { Runtime } from '@quarterdeck/rules';
import { getErrorMessage } from '../../lib/errors.js';
import { ensurePrivateDir } from '../../lib/private-fs.js';
import { quarterdeckHome } from '../../store/paths.js';
import type { AgentCommand } from '../client/types.js';
import { wholeEnv } from '../env.js';
import { runCommand } from '../launch/run.js';
import {
  CLAUDE_INITIALIZE_TIMEOUT_MS,
  NPM_PUBLIC_REGISTRY,
  claudeAgentCommand,
  claudeRuntimeDir,
} from '../runtimes/claude/adapter.js';
import {
  claudeAuthMissingHelp,
  claudeAuthStatus,
} from '../runtimes/claude/auth.js';
import { GEMINI_COMMAND } from '../runtimes/gemini/adapter.js';
import { defaultGeminiDir } from '../runtimes/gemini/lockdown.js';
import { KIRO_COMMAND } from '../runtimes/kiro/adapter.js';
import { defaultKiroProcessDir } from '../runtimes/kiro/config.js';
import { signInOverAcp, type AcpSignInTarget } from './acp-driver.js';
import { runLoginProcess, type LoginCommand } from './login-process.js';
import { BROWSER_AUTH_METHODS } from './methods.js';
import type { SignInDriver, SignInOutcome, SignInRunOptions } from './types.js';

export const RUNTIME_SIGN_IN_NAMES: Readonly<Record<Runtime, string>> = {
  claude: 'Claude Code',
  kiro: 'Kiro',
  gemini: 'Gemini CLI',
};

export const KIRO_LOGIN: LoginCommand = {
  command: KIRO_COMMAND,
  args: ['login'],
  display: 'kiro-cli login',
  opensBrowser: true,
};

const KIRO_WHOAMI_TIMEOUT_MS = 15_000;

export interface RuntimeSignInOptions extends SignInRunOptions {
  home?: string;
  platform?: NodeJS.Platform;
  command?: AgentCommand;
}

const viaShim = (
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): AgentCommand => {
  if (platform !== 'win32') return { command, args };
  return {
    command: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
};

const runtimeAgent = (
  runtime: Runtime,
  home: string,
  platform: NodeJS.Platform,
): AgentCommand => {
  if (runtime === 'claude') {
    return {
      ...claudeAgentCommand(platform),
      cwd: claudeRuntimeDir(home),
      env: { set: { npm_config_registry: NPM_PUBLIC_REGISTRY } },
    };
  }
  if (runtime === 'kiro') {
    return {
      ...viaShim(KIRO_COMMAND, ['acp'], platform),
      cwd: defaultKiroProcessDir(home),
    };
  }
  return {
    ...viaShim(GEMINI_COMMAND, ['--acp'], platform),
    cwd: defaultGeminiDir(home),
  };
};

export const runtimeSignInTarget = (
  runtime: Runtime,
  {
    home = quarterdeckHome(),
    platform = process.platform,
    command,
  }: RuntimeSignInOptions = {},
): AcpSignInTarget => {
  const agent = runtimeAgent(runtime, home, platform);
  const target: AcpSignInTarget = {
    displayName: RUNTIME_SIGN_IN_NAMES[runtime],
    methodId: BROWSER_AUTH_METHODS[runtime],
    agent: { ...agent, ...command },
    opensBrowser: true,
  };
  if (runtime === 'claude') {
    target.initializeTimeoutMs = CLAUDE_INITIALIZE_TIMEOUT_MS;
  }
  return target;
};

const kiroSignedIn = async (options: SignInRunOptions): Promise<boolean> => {
  const result = await runCommand(
    { command: KIRO_COMMAND, args: ['whoami'], env: wholeEnv(options.env) },
    { timeoutMs: KIRO_WHOAMI_TIMEOUT_MS, signal: options.signal },
  );
  return result.status === 'exited' && result.code === 0;
};

const signInKiro = async (
  target: AcpSignInTarget,
  options: SignInRunOptions,
): Promise<SignInOutcome> => {
  const acp = await signInOverAcp(target, options);
  if (await kiroSignedIn(options)) {
    if (acp.ok) return acp;
    return { ok: true, via: KIRO_LOGIN.display };
  }
  const login = await runLoginProcess(KIRO_LOGIN, options);
  if (!login.ok) return login;
  if (await kiroSignedIn(options)) return login;
  return {
    ok: false,
    reason: `${KIRO_LOGIN.display} finished but kiro-cli whoami still reports no sign-in`,
  };
};

const claudeAuthMode = async (
  options: SignInRunOptions,
): Promise<string | undefined> => {
  try {
    const { mode } = await claudeAuthStatus({
      ...(options.env && { env: options.env }),
    });
    if (mode === 'subscription') return undefined;
    return `Claude runs in the ${mode} auth mode, which the claude.ai sign-in does not change. ${claudeAuthMissingHelp(mode)}`;
  } catch (err) {
    return getErrorMessage(err);
  }
};

export const signInRuntime = async (
  runtime: Runtime,
  options: RuntimeSignInOptions = {},
): Promise<SignInOutcome> => {
  const target = runtimeSignInTarget(runtime, options);
  const real = options.command === undefined;
  if (runtime === 'claude' && real) {
    const reason = await claudeAuthMode(options);
    if (reason !== undefined) {
      options.onProgress?.({ status: 'failed', message: reason });
      return { ok: false, reason };
    }
  }
  if (target.agent.cwd !== undefined) await ensurePrivateDir(target.agent.cwd);
  if (runtime === 'kiro' && real) return signInKiro(target, options);
  return signInOverAcp(target, options);
};

export const runtimeSignInDriver =
  (runtime: Runtime, base: RuntimeSignInOptions = {}): SignInDriver =>
  (options = {}) =>
    signInRuntime(runtime, { ...base, ...options });
