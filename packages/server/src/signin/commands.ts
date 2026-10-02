import type { Runtime } from '@quarterdeck/rules';

export interface SignInCommand {
  runtime: Runtime;
  displayName: string;
  command: string;
  steps: string;
}

export const SIGN_IN_COMMANDS: Readonly<Record<Runtime, SignInCommand>> = {
  kiro: {
    runtime: 'kiro',
    displayName: 'Kiro',
    command: 'kiro-cli login',
    steps: 'Run `kiro-cli login` in a terminal and finish the sign-in.',
  },
  claude: {
    runtime: 'claude',
    displayName: 'Claude Code',
    command: 'claude /login',
    steps: 'Run `claude /login` in a terminal and finish the sign-in.',
  },
  gemini: {
    runtime: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    steps:
      'Run `gemini` in a terminal, pick a sign-in method, finish it, then quit gemini.',
  },
};

export const signInCommand = (runtime: Runtime): SignInCommand =>
  SIGN_IN_COMMANDS[runtime];
