import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  migrate,
  openStore,
  type Db,
} from '../../src/store/index.js';
import { TEST_BACKENDS, type TestDatabase } from './backends.js';

const VOYAGES_MIGRATION = '0024_voyages';
const TIMEOUT = 30_000;

const copyMigrationsBefore = (dir: string): void => {
  for (const file of readdirSync(MIGRATIONS_DIR))
    if (file.endsWith('.sql') && file < `${VOYAGES_MIGRATION}.sql`)
      copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
};

interface OldStore {
  projectId: string;
  voyageId: string;
}

const seedOldStore = async (db: Db): Promise<OldStore> => {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(sql, params);
    return rows[0]?.id ?? '';
  };
  const projectId = await one(
    `insert into projects (slug, name) values ('deck', 'deck') returning id`,
  );
  const voyageId = await one(
    `insert into rounds (project_id, number, status, goal)
     values ($1, 1, 'ended', 'ship it') returning id`,
    [projectId],
  );
  const scoped = [projectId, voyageId];
  await db.query(
    `insert into agents (project_id, round_id, name, role)
     values ($1, $2, 'pangolin', 'driver')`,
    scoped,
  );
  await db.query(
    `insert into tickets (project_id, round_id, title) values ($1, $2, 'QD1')`,
    scoped,
  );
  await db.query(
    `insert into notebook (project_id, round_id, body) values ($1, $2, 'note')`,
    scoped,
  );
  await db.query(
    `insert into budget (project_id, round_id, limit_tokens) values ($1, $2, 10)`,
    scoped,
  );
  await db.query(
    `insert into charter_proposals (project_id, round_id, body)
     values ($1, $2, 'charter')`,
    scoped,
  );
  await db.query(
    `insert into notebook_proposals (project_id, round_id, op, body)
     values ($1, $2, 'add', 'entry')`,
    scoped,
  );
  const event = (kind: string, payload: object) =>
    db.query(
      `insert into events (project_id, kind, payload) values ($1, $2, $3::jsonb)`,
      [projectId, kind, JSON.stringify(payload)],
    );
  await event('driver.round_started', {
    roundId: voyageId,
    round: 1,
    sessionId: 's1',
  });
  await event('round.settled', { roundId: voyageId, settleSeconds: 60 });
  await event('round.ended', {
    roundId: voyageId,
    round: 1,
    reason: 'settled',
  });
  await event('card.expired', { cardId: 'c1', roundId: voyageId });
  await event('crew.failed', { service: 'rounds', error: 'x', roundId: null });
  await event('ticket.created', { title: 'look around' });
  await db.query(
    `insert into intents (project_id, kind, input, status, result, settled_at)
     values ($1, 'round.start', $2::jsonb, 'applied', $3::jsonb, now())`,
    [
      projectId,
      JSON.stringify({ goal: 'ship it' }),
      JSON.stringify({ roundId: voyageId, round: 1 }),
    ],
  );
  await db.query(
    `insert into intents (project_id, kind, input, status)
     values ($1, 'round.end', $2::jsonb, 'pending')`,
    [projectId, JSON.stringify({ roundId: voyageId })],
  );
  return { projectId, voyageId };
};

const expectVoyages = async (db: Db, old: OldStore): Promise<void> => {
  const { rows: voyages } = await db.query(
    'select id, number, status, goal from voyages',
  );
  expect(voyages).toEqual([
    { id: old.voyageId, number: 1, status: 'ended', goal: 'ship it' },
  ]);
  for (const table of [
    'agents',
    'tickets',
    'notebook',
    'budget',
    'charter_proposals',
    'notebook_proposals',
  ]) {
    const { rows } = await db.query(`select voyage_id from ${table}`);
    expect(rows, table).toEqual([{ voyage_id: old.voyageId }]);
  }
  const { rows: events } = await db.query(
    'select kind, payload from events order by id',
  );
  expect(events).toEqual([
    {
      kind: 'driver.voyage_started',
      payload: { voyageId: old.voyageId, voyage: 1, sessionId: 's1' },
    },
    {
      kind: 'voyage.settled',
      payload: { voyageId: old.voyageId, settleSeconds: 60 },
    },
    {
      kind: 'voyage.ended',
      payload: { voyageId: old.voyageId, voyage: 1, reason: 'settled' },
    },
    { kind: 'card.expired', payload: { cardId: 'c1', voyageId: old.voyageId } },
    {
      kind: 'crew.failed',
      payload: { service: 'voyages', error: 'x', voyageId: null },
    },
    { kind: 'ticket.created', payload: { title: 'look around' } },
  ]);
  const { rows: intents } = await db.query(
    'select kind, input, result from intents order by seq',
  );
  expect(intents).toEqual([
    {
      kind: 'voyage.start',
      input: { goal: 'ship it' },
      result: { voyageId: old.voyageId, voyage: 1 },
    },
    { kind: 'voyage.end', input: { voyageId: old.voyageId }, result: null },
  ]);
};

describe.each(TEST_BACKENDS)('0024_voyages on $name', (backend) => {
  let dir = '';
  let database: TestDatabase;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qd-migrations-'));
    copyMigrationsBefore(dir);
    database = await backend.create();
    db = await database.connect();
  });

  afterEach(async () => {
    await db.close();
    await database.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'renames the old tables, columns, event kinds and intent kinds',
    async () => {
      await migrate(db, dir);
      const old = await seedOldStore(db);

      expect(await migrate(db)).toEqual([VOYAGES_MIGRATION]);

      await expectVoyages(db, old);
      const { rows } = await db.query<{ old: string | null }>(
        `select to_regclass('rounds')::text as old`,
      );
      expect(rows).toEqual([{ old: null }]);
    },
    TIMEOUT,
  );
});

describe('a store created before 0024_voyages', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'qd-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(
    'opens with its old rows visible as voyages',
    async () => {
      const dataDir = join(home, 'pg');
      const migrations = mkdtempSync(join(home, 'migrations-'));
      copyMigrationsBefore(migrations);
      const before = await PGlite.create(dataDir);
      await migrate(before, migrations);
      const old = await seedOldStore(before);
      await before.close();

      const store = await openStore({ project: 'deck', dataDir });
      try {
        expect(store.migrated).toEqual([VOYAGES_MIGRATION]);
        expect(store.projectId).toBe(old.projectId);
        await expectVoyages(store.db, old);
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );
});
