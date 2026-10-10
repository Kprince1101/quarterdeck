import type { Runtime } from '@quarterdeck/rules';
import { runLoginProcess, type LoginCommand } from './login-process.js';
import { RUNTIME_SIGN_IN_NAMES, signInRuntime } from './runtimes.js';
import type { SignInOutcome, SignInRunOptions } from './types.js';

export type SignInTool =
  | { kind: 'runtime'; runtime: Runtime }
  | { kind: 'gh' }
  | { kind: 'glab'; host: string };

export const GH_WEB_SIGN_IN: LoginCommand = {
  command: 'gh',
  args: ['auth', 'login', '--web', '--git-protocol', 'https'],
  display: 'gh auth login --web',
  opensBrowser: false,
};

export const glabWebSignIn = (host: string): LoginCommand => ({
  command: 'glab',
  args: [
    'auth',
    'login',
    '--hostname',
    host,
    '--web',
    '--git-protocol',
    'https',
  ],
  display: `glab auth login --hostname ${host} --web`,
  opensBrowser: false,
});

export const signInToolName = (tool: SignInTool): string => {
  if (tool.kind === 'runtime') return RUNTIME_SIGN_IN_NAMES[tool.runtime];
  if (tool.kind === 'gh') return 'GitHub (gh)';
  return `GitLab on ${tool.host} (glab)`;
};

export const runSignIn = (
  tool: SignInTool,
  options: SignInRunOptions = {},
): Promise<SignInOutcome> => {
  if (tool.kind === 'runtime') return signInRuntime(tool.runtime, options);
  if (tool.kind === 'gh') return runLoginProcess(GH_WEB_SIGN_IN, options);
  return runLoginProcess(glabWebSignIn(tool.host), options);
};
