import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SOCKET_PATH_MAX, busSocketPath } from '../../src/bus/index.js';
import { preparePrivateDir } from '../../src/bus/socket.js';

const PROJECT = '7d8f6c1e-3b2a-4c5d-9e8f-0a1b2c3d4e5f';
const LONG = `/${'h'.repeat(SOCKET_PATH_MAX)}`;

describe('busSocketPath', () => {
  it('names the socket by a hash of the project id under <home>/sock', () => {
    const path = busSocketPath(PROJECT, { home: '/home/q/.quarterdeck' });

    expect(path).toMatch(
      /^\/home\/q\/\.quarterdeck\/sock\/[0-9a-f]{16}\.sock$/,
    );
    expect(busSocketPath(PROJECT, { home: '/elsewhere' })).toMatch(
      path.slice(-21),
    );
    expect(
      busSocketPath('another-project', { home: '/home/q/.quarterdeck' }),
    ).not.toBe(path);
  });

  it('falls back to a per-user dir in tmp when the home path is too long', () => {
    const path = busSocketPath(PROJECT, { home: LONG, tmp: '/tmp' });

    expect(path).toMatch(/^\/tmp\/quarterdeck-[^/]+\/[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
  });

  it('throws a clear error when no candidate fits', () => {
    expect(() => busSocketPath(PROJECT, { home: LONG, tmp: LONG })).toThrow(
      `longer than ${SOCKET_PATH_MAX} bytes; use a shorter home or TMPDIR`,
    );
  });
});

describe('preparePrivateDir', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qd-bus-dir-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the dir with mode 0700', async () => {
    const target = join(dir, 'sock');

    await preparePrivateDir(target);

    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it('tightens an existing dir to 0700', async () => {
    const target = join(dir, 'open');
    await mkdir(target, { mode: 0o755 });

    await preparePrivateDir(target);

    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlink in place of the dir', async () => {
    const target = join(dir, 'link');
    await symlink(dir, target);

    await expect(preparePrivateDir(target)).rejects.toThrow(
      'must be a directory owned by this user',
    );
  });
});
