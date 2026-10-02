import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIPE_ALL_CONFIRMATION } from '../../src/intents/index.js';
import {
  STORE_TABLES,
  connectPostgres,
  openStore,
  projectTurnsDir,
  type Db,
} from '../../src/store/index.js';
import {
  POSTGRES_URL,
  createDatabase,
  dropDatabase,
} from '../store/backends.js';
import { projectRowCounts, seedProject } from '../store/seed.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const everyTable = (n: number) =>
  Object.fromEntries(STORE_TABLES.map((table) => [table, n]));

const emptyTables = (counts: Record<string, number>): string[] =>
  Object.keys(counts).filter((table) => counts[table] === 0);

describe.runIf(POSTGRES_URL !== '')(
  'wipe on external Postgres',
  { timeout: TIMEOUT },
  () => {
    let url = '';
    let t: TestApi;
    let db: Db;

    const createSeeded = async (project: string): Promise<string> => {
      expect((await t.send('project.create', { project })).status).toBe(200);
      const store = await t.store(project);
      await seedProject(store.db, store.projectId);
      return store.projectId;
    };

    const slugs = async () => {
      const { rows } = await db.query<{ slug: string }>(
        'select slug from projects order by slug',
      );
      return rows.map((row) => row.slug);
    };

    beforeEach(async () => {
      url = await createDatabase(POSTGRES_URL);
      t = await startTestApi([], url);
      db = await connectPostgres(url);
    }, TIMEOUT);

    afterEach(async () => {
      await db.close();
      await t.close();
      await dropDatabase(url, POSTGRES_URL);
    }, TIMEOUT);

    it('wipe.project deletes that project from every table and nothing else', async () => {
      const deck = await createSeeded('deck');
      const hold = await createSeeded('hold');
      const holdBefore = await projectRowCounts(db, hold);
      expect(emptyTables(await projectRowCounts(db, deck))).toEqual([]);
      expect(emptyTables(holdBefore)).toEqual([]);
      const turnsDir = projectTurnsDir('deck', join(t.homeDir, '.quarterdeck'));
      await mkdir(turnsDir, { recursive: true });
      await writeFile(join(turnsDir, 'input.md'), 'turn input');

      const res = await t.send('wipe.project', {
        project: 'deck',
        confirm: 'deck',
      });

      expect(res.status).toBe(200);
      expect(res.body['result']).toEqual({
        wiped: ['deck'],
        stopped: [{ project: 'deck', agent: 'pangolin' }],
      });
      expect(await projectRowCounts(db, deck)).toEqual(everyTable(0));
      expect(await projectRowCounts(db, hold)).toEqual(holdBefore);
      expect(await slugs()).toEqual(['hold']);
      expect(
        (await t.send('layout.delete', { project: 'deck', name: 'default' }))
          .status,
      ).toBe(404);
      expect(existsSync(join(t.homeDir, '.quarterdeck', 'deck'))).toBe(false);
    });

    it('refuses to wipe a project another process has open', async () => {
      await createSeeded('deck');
      const other = await openStore({ project: 'hold', databaseUrl: url });

      const res = await t.send('wipe.project', {
        project: 'hold',
        confirm: 'hold',
      });

      expect(res.status).toBe(409);
      expect(res.body['error']).toContain('project hold is already open');
      expect(await slugs()).toEqual(['deck', 'hold']);
      await other.close();
    });

    it('wipe.all deletes every project in the database', async () => {
      const deck = await createSeeded('deck');
      const hold = await createSeeded('hold');

      const res = await t.send('wipe.all', { confirm: WIPE_ALL_CONFIRMATION });

      expect(res.status).toBe(200);
      expect(res.body['result']).toEqual({
        wiped: ['deck', 'hold'],
        stopped: [
          { project: 'deck', agent: 'pangolin' },
          { project: 'hold', agent: 'pangolin' },
        ],
      });
      expect(await projectRowCounts(db, deck)).toEqual(everyTable(0));
      expect(await projectRowCounts(db, hold)).toEqual(everyTable(0));
      expect(await slugs()).toEqual([]);
    });
  },
);
