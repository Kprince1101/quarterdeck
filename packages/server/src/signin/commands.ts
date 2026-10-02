import type { AuthMethod } from '@agentclientprotocol/sdk';
import type { Runtime } from '@quarterdeck/rules';
import {
  CLAUDE_AGENT_ACP_PACKAGE,
  CLAUDE_AGENT_ACP_VERSION,
} from '../acp/runtimes/claude/adapter.js';

export interface SignInRuntime {
  runtime: Runtime;
  displayName: string;
  invocation: readonly string[];
  fallback: string;
  steps: string;
}

export interface SignInCommand {
  runtime: Runtime;
  displayName: string;
  command: string;
  steps: string;
  alternatives: readonly string[];
}

export const SIGN_IN_RUNTIMES: Readonly<Record<Runtime, SignInRuntime>> = {
  kiro: {
    runtime: 'kiro',
    displayName: 'Kiro',
    invocation: ['kiro-cli', 'acp'],
    fallback: 'kiro-cli login',
    steps: 'in a terminal and finish the sign-in.',
  },
  claude: {
    runtime: 'claude',
    displayName: 'Claude Code',
    invocation: [
      'npx',
      '--yes',
      `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`,
    ],
    fallback: 'claude auth login',
    steps: 'in a terminal and finish the sign-in.',
  },
  gemini: {
    runtime: 'gemini',
    displayName: 'Gemini CLI',
    invocation: ['gemini', '--acp'],
    fallback: 'gemini',
    steps:
      'in a terminal, pick a sign-in method, finish it, then quit Gemini CLI.',
  },
};

type TerminalAuthMethod = Extract<AuthMethod, { type: 'terminal' }>;

const SAFE_WORD = /^[\w@%+=:,./-]+$/;

const shellWord = (word: string): string => {
  if (SAFE_WORD.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
};

const isTerminalMethod = (method: AuthMethod): method is TerminalAuthMethod =>
  'type' in method && method.type === 'terminal';

const terminalCommand = (
  runtime: SignInRuntime,
  method: TerminalAuthMethod,
): string => {
  const env = Object.entries(method.env ?? {}).map(
    ([key, value]) => `${key}=${shellWord(value)}`,
  );
  const words = [...runtime.invocation, ...(method.args ?? [])];
  return [...env, ...words.map(shellWord)].join(' ');
};

export const signInCommand = (
  runtime: Runtime,
  authMethods: readonly AuthMethod[] = [],
): SignInCommand => {
  const site = SIGN_IN_RUNTIMES[runtime];
  const commands = authMethods
    .filter(isTerminalMethod)
    .map((method) => terminalCommand(site, method));
  const [command = site.fallback, ...alternatives] = commands;
  return {
    runtime,
    displayName: site.displayName,
    command,
    steps: `Run \`${command}\` ${site.steps}`,
    alternatives,
  };
};
