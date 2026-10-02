import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quarterdeckHome } from '../store/index.js';

export const SOCKET_PATH_MAX = 100;

const PRIVATE_DIR = 0o700;
const SOCKET_HASH_LENGTH = 16;

export interface SocketPathOptions {
  home?: string | undefined;
  tmp?: string | undefined;
}

const userTag = (): string => String(process.getuid?.() ?? 'user');

const fits = (path: string): boolean =>
  Buffer.byteLength(path) <= SOCKET_PATH_MAX;

export const busSocketDir = (home: string = quarterdeckHome()): string =>
  join(home, 'sock');

export const busSocketPath = (
  projectId: string,
  options: SocketPathOptions = {},
): string => {
  const hash = createHash('sha256')
    .update(projectId)
    .digest('hex')
    .slice(0, SOCKET_HASH_LENGTH);
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\quarterdeck-bus-${hash}`;
  const name = `${hash}.sock`;
  const candidates = [
    join(busSocketDir(options.home), name),
    join(options.tmp ?? tmpdir(), `quarterdeck-${userTag()}`, name),
  ];
  const path = candidates.find(fits);
  if (path === undefined)
    throw new Error(
      `bus socket paths ${candidates.join(' and ')} are longer than ${SOCKET_PATH_MAX} bytes; use a shorter home or TMPDIR`,
    );
  return path;
};

export const assertSocketPath = (path: string): string => {
  if (process.platform !== 'win32' && !fits(path))
    throw new Error(
      `bus socket path ${path} is ${Buffer.byteLength(path)} bytes; the limit is ${SOCKET_PATH_MAX}`,
    );
  return path;
};

export const preparePrivateDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  const stats = await lstat(dir);
  const uid = process.getuid?.();
  if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid))
    throw new Error(
      `bus socket dir ${dir} must be a directory owned by this user`,
    );
  if ((stats.mode & 0o777) !== PRIVATE_DIR) await chmod(dir, PRIVATE_DIR);
};
