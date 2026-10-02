export interface Prompter {
  ask: (question: string) => Promise<string>;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  homeDir: string;
  cwd: string;
  prompter: Prompter | undefined;
  untilStopped: () => Promise<void>;
}

export type Command = (args: string[], io: CliIo) => Promise<number>;

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
