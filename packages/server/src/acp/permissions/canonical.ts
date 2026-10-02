import { readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_LINK_HOPS = 40;
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const NOT_A_LINK_CODES: ReadonlySet<string> = new Set([
  ...MISSING_CODES,
  'EINVAL',
]);

const hasCode = (err: unknown, codes: ReadonlySet<string>): boolean =>
  err instanceof Error &&
  'code' in err &&
  typeof err.code === 'string' &&
  codes.has(err.code);

export const expandHome = (path: string, home: string = homedir()): string => {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (path.startsWith('~')) return join(dirname(home), path.slice(1));
  return path;
};

const existingRealpath = async (path: string): Promise<string | undefined> => {
  try {
    return await realpath(path);
  } catch (err) {
    if (hasCode(err, MISSING_CODES)) return undefined;
    throw err;
  }
};

const danglingTarget = async (path: string): Promise<string | undefined> => {
  try {
    return await readlink(path);
  } catch (err) {
    if (hasCode(err, NOT_A_LINK_CODES)) return undefined;
    throw err;
  }
};

const canonicalize = async (path: string, hops: number): Promise<string> => {
  const existing = await existingRealpath(path);
  if (existing !== undefined) return existing;
  const parent = dirname(path);
  if (parent === path) return path;
  const joined = join(await canonicalize(parent, hops), basename(path));
  const target = await danglingTarget(joined);
  if (target === undefined) return joined;
  if (hops >= MAX_LINK_HOPS) {
    throw new Error(`too many symbolic links resolving ${path}`);
  }
  return canonicalize(resolve(dirname(joined), target), hops + 1);
};

export const canonicalPath = (path: string, base?: string): Promise<string> =>
  canonicalize(resolve(base ?? '.', expandHome(path)), 0);
