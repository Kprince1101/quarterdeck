import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENTS_CHANNEL,
  STORE_TABLES,
  deleteProjectRows,
  openStore,
} from '../../src/store/index.js';
import type { Store } from '../../src/store/index.js';
import {
  SHIPPED_MIGRATIONS,
  TEST_BACKENDS,
  nextPayload,
  type TestDatabase,
} from './backends.js';
import { projectRowCounts, seedProject } from './seed.js';

const TIMEOUT = 30_000;

describe('openStore on disk', () => {
  let home = '';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'qd-home-'));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(
    'creates the project data dir, migrates once and persists across restarts',
    async () => {
      const first = await openStore({ project: 'deck', home });
      expect(first.backend).toBe('pglite');
      expect(first.location).toBe(join(home, 'deck', 'pg'));
      expect(existsSync(join(first.location, 'PG_VERSION'))).toBe(true);
      expect(first.migrated).toEqual(SHIPPED_MIGRATIONS);
      await first.db.query(
        'insert into notebook (project_id, body) values ($1, $2)',
        [first.projectId, 'remember this'],
      );
      await first.close();

      const second = await openStore({ project: 'deck', home });
      expect(second.migrated).toEqual([]);
      expect(second.projectId).toBe(first.projectId);
      const { rows } = await second.db.query<{ body: string }>(
        'select body from notebook',
      );
      expect(rows).toEqual([{ body: 'remember this' }]);
      await second.close();
    },
    TIMEOUT,
  );

  it('rejects an unsafe project slug before touching disk', async () => {
    await expect(openStore({ project: '../x', home })).rejects.toThrow(
      'Invalid project slug',
    );
    expect(existsSync(join(home, 'x'))).toBe(false);
  });
});

describe.each(TEST_BACKENDS)('store schema on $name', (backend) => {
  let database: TestDatabase;
  let store: Store;

  beforeAll(async () => {
    database = await backend.create();
    store = await openStore({ project: 'deck', ...database.storeOptions });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
    await database.drop();
  });

  it('deletes one project from every store table and leaves the rest', async () => {
    const { rows } = await store.db.query<{ id: string; slug: string }>(
      `insert into projects (slug, name)
       values ('hold', 'hold'), ('keep', 'keep') returning id, slug`,
    );
    const ids = Object.fromEntries(rows.map((row) => [row.slug, row.id]));
    const hold = ids['hold'] ?? '';
    const keep = ids['keep'] ?? '';
    await seedProject(store.db, hold);
    await seedProject(store.db, keep);
    const everyTable = (n: number) =>
      Object.fromEntries(STORE_TABLES.map((table) => [table, n]));
    expect(await projectRowCounts(store.db, hold)).toEqual(everyTable(1));

    await store.db.transaction((tx) => deleteProjectRows(tx, hold));

    expect(await projectRowCounts(store.db, hold)).toEqual(everyTable(0));
    expect(await projectRowCounts(store.db, keep)).toEqual(everyTable(1));
    await store.db.query('delete from projects where id = $1', [keep]);
  });

  it('gives events consecutive ids', async () => {
    const first = await store.publish({ kind: 'one' });
    const second = await store.publish({ kind: 'two' });
    expect(second.id).toBe(first.id + 1);
    await store.db.query('delete from events where project_id = $1', [
      store.projectId,
    ]);
  });

  it('reports which backend it opened', () => {
    expect(store.backend).toBe(backend.name);
  });

  it('returns the same JS values on every backend', async () => {
    const { rows } = await store.db.query(
      `select 42::int8 as small_int8, 9007199254740993::int8 as big_int8,
              7::int4 as int4, 1.5::numeric(12, 4) as numeric,
              '{"a":[1]}'::jsonb as jsonb, true as bool,
              '2026-10-01T00:00:00Z'::timestamptz as at,
              array['8f0c1e9a-5b7d-4c2e-9a1f-3d6b8e2c4a10']::uuid[] as ids`,
    );
    expect(rows).toEqual([
      {
        small_int8: 42,
        big_int8: 9_007_199_254_740_993n,
        int4: 7,
        numeric: '1.5000',
        jsonb: { a: [1] },
        bool: true,
        at: new Date('2026-10-01T00:00:00Z'),
        ids: ['8f0c1e9a-5b7d-4c2e-9a1f-3d6b8e2c4a10'],
      },
    ]);
  });

  afterEach(async () => {
    await store.db.exec('delete from agents; delete from rounds;');
  });

  const insertAgent = (status: string) =>
    store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, 'pangolin', 'builder', $2) returning id`,
      [store.projectId, status],
    );

  it('creates every table', async () => {
    const { rows } = await store.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name <> 'schema_migrations'
       order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(
      [...STORE_TABLES].toSorted(),
    );
  });

  it('registers the project row', async () => {
    const { rows } = await store.db.query<{ slug: string; name: string }>(
      'select slug, name from projects where id = $1',
      [store.projectId],
    );
    expect(rows).toEqual([{ slug: 'deck', name: 'deck' }]);
  });

  it('defaults agents to kiro and rejects unknown lifecycle states', async () => {
    const {
      rows: [agent],
    } = await insertAgent('working');
    const { rows } = await store.db.query<{ runtime: string }>(
      'select runtime from agents where id = $1',
      [agent?.id],
    );
    expect(rows).toEqual([{ runtime: 'kiro' }]);
    await expect(insertAgent('zombie')).rejects.toThrow(/check constraint/);
  });

  it('keeps one budget row per project, round and agent scope', async () => {
    const insertBudget = () =>
      store.db.query(
        'insert into budget (project_id, limit_tokens) values ($1, 1000)',
        [store.projectId],
      );
    await insertBudget();
    await expect(insertBudget()).rejects.toThrow(/unique/);
  });

  it('notifies the events channel on every event insert', async () => {
    const { payload, unlisten } = await nextPayload(store.db, EVENTS_CHANNEL);
    const {
      rows: [event],
    } = await store.db.query<{ id: number }>(
      `insert into events (project_id, kind, payload)
       values ($1, 'ticket.created', '{"title":"QD2a"}') returning id`,
      [store.projectId],
    );
    const received = JSON.parse(await payload) as unknown;
    await unlisten();

    expect(received).toEqual({
      id: event?.id,
      project_id: store.projectId,
      kind: 'ticket.created',
    });
  });

  it('commits a transaction as a unit and rolls it back on error', async () => {
    await store.db.transaction(async (tx) => {
      await tx.query(`insert into rounds (project_id, number) values ($1, 1)`, [
        store.projectId,
      ]);
    });
    await expect(
      store.db.transaction(async (tx) => {
        await tx.query(
          `insert into rounds (project_id, number) values ($1, 2)`,
          [store.projectId],
        );
        await tx.query(
          `insert into rounds (project_id, number) values ($1, 1)`,
          [store.projectId],
        );
      }),
    ).rejects.toThrow(/unique/);
    const { rows } = await store.db.query<{ number: number }>(
      'select number from rounds where project_id = $1',
      [store.projectId],
    );
    expect(rows).toEqual([{ number: 1 }]);
  });

  it('maintains updated_at on every table that has one', async () => {
    const { rows } = await store.db.query<{
      table_name: string;
      touched: boolean;
    }>(
      `select c.table_name, exists (
         select 1 from information_schema.triggers t
         where t.event_object_table = c.table_name
           and t.event_manipulation = 'UPDATE'
           and t.action_timing = 'BEFORE'
           and t.action_statement = 'EXECUTE FUNCTION touch_updated_at()'
       ) as touched
       from information_schema.columns c
       where c.table_schema = 'public' and c.column_name = 'updated_at'
       order by c.table_name`,
    );
    expect(rows).toEqual(
      ['agents', 'budget', 'layouts', 'projects', 'tickets'].map(
        (table_name) => ({ table_name, touched: true }),
      ),
    );

    const {
      rows: [ticket],
    } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title, updated_at)
       values ($1, 'stale', '2000-01-01') returning id`,
      [store.projectId],
    );
    const { rows: touched } = await store.db.query<{ fresh: boolean }>(
      `update tickets set title = 'fresh' where id = $1
       returning updated_at > now() - interval '1 minute' as fresh`,
      [ticket?.id],
    );
    expect(touched).toEqual([{ fresh: true }]);
  });

  it('scopes every layout to a project', async () => {
    await expect(
      store.db.query(`insert into layouts (name, spec) values ('board', '{}')`),
    ).rejects.toThrow(/not-null/);
  });

  it('nulls ticket assignees when their agent is removed', async () => {
    const {
      rows: [agent],
    } = await insertAgent('idle');
    const {
      rows: [ticket],
    } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title, assignee_id, status)
       values ($1, 'QD2a', $2, 'assigned') returning id`,
      [store.projectId, agent?.id],
    );
    await store.db.query('delete from agents where id = $1', [agent?.id]);
    const { rows } = await store.db.query<{ assignee_id: string | null }>(
      'select assignee_id from tickets where id = $1',
      [ticket?.id],
    );
    expect(rows).toEqual([{ assignee_id: null }]);
  });
});
