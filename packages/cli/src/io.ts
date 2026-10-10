export interface Prompter {
  ask: (question: string) => Promise<string>;
}

export type CommandRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<void>;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  homeDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompter: Prompter | undefined;
  untilStopped: () => Promise<void>;
  run?: CommandRunner | undefined;
}

export type Command = (args: string[], io: CliIo) => Promise<number>;

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
