import { RulesError } from '@quarterdeck/rules';
import { HttpError } from '@quarterdeck/server';
import { runInit } from './init.js';
import { CliError, type CliIo, type Command } from './io.js';
import { runUp } from './up.js';

export const CANCELLED_EXIT_CODE = 130;

export const USAGE = `Usage: quarterdeck <command> [options]

Commands:
  up                Start the server and dashboard and print the URL
  init [repo-path]  Create a project from a git repository

Run quarterdeck <command> --help for a command's options.`;

const COMMANDS: Record<string, Command> = { up: runUp, init: runInit };

const HELP = new Set(['help', '--help', '-h']);

const isParseArgsError = (err: unknown): err is Error =>
  err instanceof TypeError &&
  'code' in err &&
  typeof err.code === 'string' &&
  err.code.startsWith('ERR_PARSE_ARGS_');

const reportError = (err: unknown, io: CliIo): number => {
  if (err instanceof Error && err.name === 'AbortError') {
    io.err('Cancelled.');
    return CANCELLED_EXIT_CODE;
  }
  if (
    err instanceof CliError ||
    err instanceof HttpError ||
    err instanceof RulesError ||
    isParseArgsError(err)
  ) {
    io.err(err.message);
    return 1;
  }
  throw err;
};

export const main = async (argv: string[], io: CliIo): Promise<number> => {
  const [name, ...args] = argv;
  if (name === undefined) {
    io.err(USAGE);
    return 1;
  }
  if (HELP.has(name)) {
    io.out(USAGE);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) && COMMANDS[name];
  if (!command) {
    io.err(`Unknown command ${name}\n\n${USAGE}`);
    return 1;
  }
  try {
    return await command(args, io);
  } catch (err) {
    return reportError(err, io);
  }
};
