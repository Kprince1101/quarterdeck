import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  STORE_TABLES,
  WATCHED_TABLES,
  openStore,
  readRows,
} from '../../src/store/index.js';
import type { Store, TableChange, Watcher } from '../../src/store/index.js';
import { TEST_BACKENDS, type TestDatabase } from './backends.js';

const TIMEOUT = 30_000;

describe.each(TEST_BACKENDS)('store table changes on $name', (backend) => {
  let database: TestDatabase;
  let store: Store;
  const open: Watcher[] = [];

  const watch = async (...args: Parameters<Store['watch']>) => {
    const watcher = await store.watch(...args);
    open.push(watcher);
    return watcher;
  };

  const collect = async () => {
    const changes: TableChange[] = [];
    await watch((change) => {
      changes.push(change);
    });
    return changes;
  };

  let agents = 0;
  const insertAgent = async (projectId = store.projectId) => {
    agents += 1;
    const {
      rows: [agent],
    } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role)
       values ($1, $2, 'builder') returning id`,
      [projectId, `agent-${agents}`],
    );
    if (!agent) throw new Error('no agent');
    return agent.id;
  };

  beforeAll(async () => {
    database = await backend.create();
    store = await openStore({ project: 'deck', ...database.storeOptions });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
    await database.drop();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((watcher) => watcher.close()));
    await store.db.exec(
      `delete from tickets; delete from turns; delete from agents;
       delete from projects where slug <> 'deck';`,
    );
  });

  it('watches every table except the event and intent logs', () => {
    const logs: readonly string[] = ['events', 'intents'];
    expect([...WATCHED_TABLES].toSorted()).toEqual(
      STORE_TABLES.filter((table) => !logs.includes(table)).toSorted(),
    );
  });

  it('has a change trigger on every watched table', async () => {
    const { rows } = await store.db.query<{ table: string }>(
      `select distinct event_object_table as table
       from information_schema.triggers
       where action_statement = 'EXECUTE FUNCTION notify_change()'
       order by 1`,
    );
    expect(rows.map((row) => row.table)).toEqual(
      [...WATCHED_TABLES].toSorted(),
    );
  });

  it('delivers inserts, updates and deletes with the current row', async () => {
    const changes = await collect();
    const {
      rows: [ticket],
    } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title) values ($1, 'QD6b') returning id`,
      [store.projectId],
    );
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    await store.db.query(`update tickets set status = 'done' where id = $1`, [
      ticket?.id,
    ]);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    await store.db.query('delete from tickets where id = $1', [ticket?.id]);

    await vi.waitFor(() => expect(changes).toHaveLength(3));
    const [inserted, updated, deleted] = changes;
    expect(inserted).toMatchObject({
      table: 'tickets',
      op: 'insert',
      id: ticket?.id,
      row: { id: ticket?.id, projectId: store.projectId, dependsOn: [] },
    });
    expect(updated?.op).toBe('update');
    expect(deleted).toEqual({
      table: 'tickets',
      op: 'delete',
      id: ticket?.id,
      row: null,
    });
  });

  it('reads the row as it is when the change is delivered', async () => {
    const changes = await collect();
    await store.db.transaction(async (tx) => {
      await tx.query(
        `insert into tickets (project_id, title) values ($1, 'draft')`,
        [store.projectId],
      );
      await tx.query(`update tickets set title = 'final'`);
    });

    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes.map((change) => change.row?.title)).toEqual([
      'final',
      'final',
    ]);
  });

  it('scopes turns through their agent and keeps numeric ids', async () => {
    const changes = await collect();
    const agentId = await insertAgent();
    const {
      rows: [turn],
    } = await store.db.query<{ id: number }>(
      `insert into turns (agent_id, seq, prompt) values ($1, 1, 'go') returning id`,
      [agentId],
    );

    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toMatchObject({
      table: 'turns',
      op: 'insert',
      id: turn?.id,
      row: { agentId, seq: 1, inputTokens: 0 },
    });
    expect(changes[1]?.row).not.toHaveProperty('prompt');
  });

  it('ignores rows of other projects, including cascaded turn deletes', async () => {
    const changes = await collect();
    const {
      rows: [other],
    } = await store.db.query<{ id: string }>(
      `insert into projects (slug, name) values ('other', 'other') returning id`,
    );
    const theirs = await insertAgent(other?.id);
    await store.db.query(
      `insert into turns (agent_id, seq, prompt) values ($1, 1, 'theirs')`,
      [theirs],
    );
    await store.db.query('delete from agents where id = $1', [theirs]);
    await insertAgent();

    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({ table: 'agents', op: 'insert' });
  });

  it('sends an agent delete, not its cascaded turn deletes', async () => {
    const changes = await collect();
    const agentId = await insertAgent();
    await store.db.query(
      `insert into turns (agent_id, seq, prompt) values ($1, 1, 'go')`,
      [agentId],
    );
    await store.db.query('delete from agents where id = $1', [agentId]);
    await insertAgent();

    await vi.waitFor(() => expect(changes).toHaveLength(4));
    expect(changes.map((change) => [change.table, change.op])).toEqual([
      ['agents', 'insert'],
      ['turns', 'insert'],
      ['agents', 'delete'],
      ['agents', 'insert'],
    ]);
  });

  it('reads only the latest turns per agent when asked', async () => {
    const first = await insertAgent();
    const second = await insertAgent();
    await store.db.query(
      `insert into turns (agent_id, seq, prompt)
       select agent, n, 'p' from unnest($1::uuid[]) as agent,
       generate_series(1, 5) as n`,
      [[first, second]],
    );

    const all = await readRows(store.db, store.projectId, 'turns');
    const latest = await readRows(store.db, store.projectId, 'turns', {
      turnsPerAgent: 2,
    });

    expect(all).toHaveLength(10);
    expect(all[0]).not.toHaveProperty('prompt');
    const seqs = (agentId: string) =>
      new Set(
        latest
          .filter((turn) => turn.agentId === agentId)
          .map((turn) => turn.seq),
      );
    expect(latest).toHaveLength(4);
    expect(seqs(first)).toEqual(new Set([4, 5]));
    expect(seqs(second)).toEqual(new Set([4, 5]));
  });

  it('reports a failing handler and keeps watching', async () => {
    const errors: unknown[] = [];
    const ops: string[] = [];
    await watch(
      (change) => {
        ops.push(change.op);
        if (change.op === 'insert') throw new Error('handler broke');
      },
      { onError: (err) => errors.push(err) },
    );
    const agentId = await insertAgent();
    await store.db.query(`update agents set status = 'idle' where id = $1`, [
      agentId,
    ]);

    await vi.waitFor(() => expect(ops).toEqual(['insert', 'update']));
    expect(errors).toEqual([new Error('handler broke')]);
  });

  it('stops delivering once closed', async () => {
    const changes: TableChange[] = [];
    const watcher = await watch((change) => {
      changes.push(change);
    });
    await insertAgent();
    await vi.waitFor(() => expect(changes).toHaveLength(1));

    await watcher.close();
    await watcher.close();
    await insertAgent();
    const late = await collect();
    await insertAgent();

    await vi.waitFor(() => expect(late).toHaveLength(1));
    expect(changes).toHaveLength(1);
  });
});
