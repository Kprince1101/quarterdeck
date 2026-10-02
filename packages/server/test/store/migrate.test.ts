import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../store/index.js';

describe('migrate', () => {
  let dir = '';
  let db: PGlite;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qd-migrations-'));
    db = await PGlite.create();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, sql: string) =>
    writeFileSync(join(dir, file), sql);

  it('ships 0001_init as the first migration', async () => {
    const [first] = await loadMigrations();
    expect(first?.version).toBe('0001_init');
  });

  it('applies pending migrations in version order, once', async () => {
    write('0002_b.sql', 'insert into log values (2);');
    write(
      '0001_a.sql',
      'create table log (n int); insert into log values (1);',
    );
    write('notes.txt', 'ignored');

    expect(await migrate(db, dir)).toEqual(['0001_a', '0002_b']);
    expect(await migrate(db, dir)).toEqual([]);

    write('0003_c.sql', 'insert into log values (3);');
    expect(await migrate(db, dir)).toEqual(['0003_c']);

    const { rows } = await db.query<{ n: number }>('select n from log');
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3]);
  });

  it.each(['0002_AddX.sql', '2_x.sql', '0003-dash.sql'])(
    'refuses to run when %s does not match NNNN_name.sql',
    async (file) => {
      write('0001_a.sql', 'create table good (n int);');
      write(file, 'create table never (n int);');

      await expect(migrate(db, dir)).rejects.toThrow(
        `Migration ${file} must be named NNNN_name.sql`,
      );
      const { rows } = await db.query<{ good: string | null }>(
        `select to_regclass('good')::text as good`,
      );
      expect(rows).toEqual([{ good: null }]);
    },
  );

  it('rolls back a failing migration and leaves it pending', async () => {
    write('0001_a.sql', 'create table good (n int);');
    write('0002_bad.sql', 'create table half (n int); select nope;');

    await expect(migrate(db, dir)).rejects.toThrow();

    const { rows } = await db.query<{ version: string; half: string | null }>(
      `select version, to_regclass('half')::text as half
       from schema_migrations`,
    );
    expect(rows).toEqual([{ version: '0001_a', half: null }]);
  });
});
