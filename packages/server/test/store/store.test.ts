import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENTS_CHANNEL,
  IN_MEMORY,
  STORE_TABLES,
  openStore,
} from '../../src/store/index.js';
import type { Store } from '../../src/store/index.js';

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
      expect(first.dataDir).toBe(join(home, 'deck', 'pg'));
      expect(existsSync(join(first.dataDir, 'PG_VERSION'))).toBe(true);
      expect(first.migrated).toEqual([
        '0001_init',
        '0002_agent_names',
        '0003_intents',
        '0004_table_changes',
      ]);
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

describe('store schema', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
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
    const payloads: string[] = [];
    const unlisten = await store.db.listen(EVENTS_CHANNEL, (payload) => {
      payloads.push(payload);
    });
    const {
      rows: [event],
    } = await store.db.query<{ id: number }>(
      `insert into events (project_id, kind, payload)
       values ($1, 'ticket.created', '{"title":"QD2a"}') returning id`,
      [store.projectId],
    );
    await unlisten();

    expect(payloads.map((payload) => JSON.parse(payload) as unknown)).toEqual([
      { id: event?.id, project_id: store.projectId, kind: 'ticket.created' },
    ]);
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
