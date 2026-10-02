import { resolve } from 'node:path';
import { isInsideRepo } from './paths.js';

export interface ShellRequest {
  cwd: string;
  command: string;
  argPaths?: readonly string[] | undefined;
}

const SHELL_CONTROL = /[;&|<>`$\n\r]/;
const SEGMENT_SEPARATOR = /&&|\|\||[;&|\n\r]/;
const QUOTES = /["']/g;
const HOME_PREFIX = '~';

export const hasShellControl = (command: string): boolean =>
  SHELL_CONTROL.test(command);

export const commandSegments = (command: string): string[] =>
  command
    .split(SEGMENT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const commandTokens = (command: string): string[] =>
  command
    .replace(QUOTES, '')
    .split(/\s+/)
    .filter((token) => token.length > 0);

const tokenPaths = (token: string): string[] => {
  const assigned = token.indexOf('=');
  if (assigned < 0) return [token];
  return [token, token.slice(assigned + 1)];
};

export const commandArguments = (command: string): string[] =>
  commandTokens(command)
    .flatMap(tokenPaths)
    .filter((candidate) => candidate.length > 0);

const looksLikePath = (candidate: string): boolean =>
  candidate.includes('/') || candidate === '..';

const escapesRepo = (repoDir: string, cwd: string, candidate: string) => {
  if (candidate.startsWith(HOME_PREFIX)) return true;
  if (!looksLikePath(candidate)) return false;
  return !isInsideRepo(repoDir, resolve(cwd, candidate));
};

export const isPinnedCommand = (
  repoDir: string,
  { cwd, command, argPaths = [] }: ShellRequest,
): boolean => {
  if (!isInsideRepo(repoDir, cwd)) return false;
  if (hasShellControl(command)) return false;
  if (!argPaths.every((path) => isInsideRepo(repoDir, path))) return false;
  return !commandArguments(command).some((candidate) =>
    escapesRepo(repoDir, cwd, candidate),
  );
};
