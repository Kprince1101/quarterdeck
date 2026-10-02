import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openStore } from '../../store/index.js';

const TIMEOUT = 30_000;

const deadPid = (): number => {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  if (pid === undefined) throw new Error('could not spawn a child process');
  return pid;
};

describe('data dir lock', () => {
  let home = '';
  let lockFile = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'qd-lock-'));
    lockFile = join(home, 'deck', 'pg.lock');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(
    'rejects a second open of a project that is already open',
    async () => {
      const first = await openStore({ project: 'deck', home });
      expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid));

      await expect(openStore({ project: 'deck', home })).rejects.toThrow(
        `project deck is already open (pid ${process.pid})`,
      );

      const { rows } = await first.db.query<{ n: number }>('select 1 as n');
      expect(rows).toEqual([{ n: 1 }]);
      expect(existsSync(lockFile)).toBe(true);
      await first.close();
    },
    TIMEOUT,
  );

  it(
    'releases the lock on close so the project can be reopened',
    async () => {
      const first = await openStore({ project: 'deck', home });
      await first.close();
      expect(existsSync(lockFile)).toBe(false);

      const second = await openStore({ project: 'deck', home });
      expect(existsSync(lockFile)).toBe(true);
      await second.close();
      expect(existsSync(lockFile)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'reclaims a lock left by a process that has exited',
    async () => {
      mkdirSync(join(home, 'deck'), { recursive: true });
      writeFileSync(lockFile, String(deadPid()));

      const store = await openStore({ project: 'deck', home });
      expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
      await store.close();
    },
    TIMEOUT,
  );

  it(
    'releases the lock when the database fails to start',
    async () => {
      mkdirSync(join(home, 'deck', 'pg'), { recursive: true });
      writeFileSync(join(home, 'deck', 'pg', 'PG_VERSION'), 'not postgres');

      await expect(openStore({ project: 'deck', home })).rejects.toThrow();
      expect(existsSync(lockFile)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'does not lock in-memory stores',
    async () => {
      const first = await openStore({ project: 'deck', dataDir: IN_MEMORY });
      const second = await openStore({ project: 'deck', dataDir: IN_MEMORY });
      await Promise.all([first.close(), second.close()]);
    },
    TIMEOUT,
  );
});
