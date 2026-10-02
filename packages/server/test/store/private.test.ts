import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setGlobalPause, globalPausePath } from '../../src/pause/index.js';
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  dataDirLockPath,
  ensurePrivateDir,
  openStore,
  projectDataDir,
  projectDir,
  quarterdeckHome,
  writePrivateFile,
} from '../../src/store/index.js';

const TIMEOUT = 30_000;
const LOOSE_DIR = 0o755;
const LOOSE_FILE = 0o644;
const posixOnly = it.skipIf(process.platform === 'win32');

const modeOf = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

describe('private ~/.quarterdeck', () => {
  let tempHome = '';
  let home = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'qd-private-'));
    home = quarterdeckHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  posixOnly(
    'creates a fresh home, project dir and data dir as 0700',
    async () => {
      const store = await openStore({ project: 'example', home });
      try {
        expect(await modeOf(home)).toBe(PRIVATE_DIR_MODE);
        expect(await modeOf(projectDir('example', home))).toBe(
          PRIVATE_DIR_MODE,
        );
        const pg = projectDataDir('example', home);
        expect(await modeOf(pg)).toBe(PRIVATE_DIR_MODE);
        expect(await modeOf(dataDirLockPath(pg))).toBe(PRIVATE_FILE_MODE);
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  posixOnly(
    'tightens a pre-existing loose home to 0700 on open',
    async () => {
      await mkdir(projectDir('example', home), { recursive: true });
      await chmod(home, LOOSE_DIR);
      await chmod(projectDir('example', home), LOOSE_DIR);
      expect(await modeOf(home)).toBe(LOOSE_DIR);

      const store = await openStore({ project: 'example', home });
      try {
        expect(await modeOf(home)).toBe(PRIVATE_DIR_MODE);
        expect(await modeOf(projectDir('example', home))).toBe(
          PRIVATE_DIR_MODE,
        );
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  posixOnly('ensurePrivateDir creates and tightens directories', async () => {
    const nested = join(home, 'example', 'turns');
    await ensurePrivateDir(nested);
    expect(await modeOf(home)).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(nested)).toBe(PRIVATE_DIR_MODE);

    await chmod(nested, LOOSE_DIR);
    await ensurePrivateDir(nested);
    expect(await modeOf(nested)).toBe(PRIVATE_DIR_MODE);
  });

  posixOnly(
    'writePrivateFile writes 0600, even over a loose file',
    async () => {
      await ensurePrivateDir(home);
      const path = join(home, 'example.json');
      await writePrivateFile(path, '{}\n');
      expect(await modeOf(path)).toBe(PRIVATE_FILE_MODE);

      await writeFile(path, 'old');
      await chmod(path, LOOSE_FILE);
      await writePrivateFile(path, '{"fresh":true}\n');
      expect(await modeOf(path)).toBe(PRIVATE_FILE_MODE);
    },
  );

  posixOnly('writes the global pause file as 0600', async () => {
    await setGlobalPause(home, true);
    expect(await modeOf(home)).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(globalPausePath(home))).toBe(PRIVATE_FILE_MODE);
  });

  it('creates the home without failing on any platform', async () => {
    await ensurePrivateDir(home);
    await writePrivateFile(join(home, 'example.txt'), 'ok');
    expect((await stat(home)).isDirectory()).toBe(true);
  });
});
