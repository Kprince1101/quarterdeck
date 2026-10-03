import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/index.js';
import {
  READ_LIMIT_MAX,
  READ_REPLY_MAX_BYTES,
  READ_TABLE_NAMES,
  buildReadQuery,
  type ReadTableName,
} from '../../src/bus/index.js';
import {
  TIMEOUT,
  callTool,
  connectClient,
  insertAgent,
  insertProject,
  openTestStore,
  readRows,
} from './fixtures.ts';

interface Seeded {
  agentId: string;
  otherAgentId: string;
  ticketIds: string[];
}

const insertTicket = async (
  store: Store,
  projectId: string,
  title: string,
  extra: { status?: string; assignee?: string; dependsOn?: string[] } = {},
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into tickets (project_id, title, status, assignee_id, depends_on)
     values ($1, $2, $3, $4, $5::uuid[]) returning id`,
    [
      projectId,
      title,
      extra.status ?? 'open',
      extra.assignee ?? null,
      extra.dependsOn ?? [],
    ],
  );
  const [row] = rows;
  if (!row) throw new Error(`could not insert ticket ${title}`);
  return row.id;
};

const seed = async (store: Store): Promise<Seeded> => {
  const agentId = await insertAgent(store, store.projectId, 'okapi');
  const first = await insertTicket(store, store.projectId, 'QD4a bus read');
  const second = await insertTicket(store, store.projectId, 'QD4b ask 100%', {
    status: 'assigned',
    assignee: agentId,
    dependsOn: [first],
  });
  const third = await insertTicket(store, store.projectId, 'QD4c report', {
    status: 'done',
  });
  await store.db.query(
    `insert into turns (agent_id, seq, prompt, input_tokens)
     values ($1, 1, 'mine', 12)`,
    [agentId],
  );
  await store.publish({
    kind: 'agent.status',
    agentId,
    payload: { text: 'hi' },
  });

  const other = await insertProject(store, 'elsewhere');
  const otherAgentId = await insertAgent(store, other, 'quetzal');
  await insertTicket(store, other, 'other project ticket');
  await store.db.query(
    `insert into turns (agent_id, seq, prompt) values ($1, 1, 'theirs')`,
    [otherAgentId],
  );
  await store.db.query(
    `insert into events (project_id, agent_id, kind) values ($1, $2, 'other')`,
    [other, otherAgentId],
  );
  return { agentId, otherAgentId, ticketIds: [first, second, third] };
};

describe('bus read', () => {
  let store: Store;
  let client: Client;
  let seeded: Seeded;

  beforeAll(async () => {
    store = await openTestStore('reader');
    seeded = await seed(store);
    client = await connectClient(store, seeded.agentId);
  }, TIMEOUT);

  afterAll(async () => {
    await client.close();
    await store.close();
  });

  it('lists the allowlisted tables in the tool schema and description', async () => {
    const { tools } = await client.listTools();
    const read = tools.find((tool) => tool.name === 'read');
    const table = read?.inputSchema.properties?.table as { enum: string[] };

    expect(table.enum).toEqual(READ_TABLE_NAMES);
    expect(table.enum).not.toContain('layouts');
    expect(read?.description).toContain('tickets(id:uuid, voyage_id:uuid');
  });

  it('returns only rows of the caller project', async () => {
    const titles = await readRows(client, {
      table: 'tickets',
      columns: ['title'],
      order: [{ column: 'title' }],
    });

    expect(titles).toEqual([
      { title: 'QD4a bus read' },
      { title: 'QD4b ask 100%' },
      { title: 'QD4c report' },
    ]);
  });

  it('scopes projects to the caller project row', async () => {
    expect(
      await readRows(client, { table: 'projects', columns: ['slug'] }),
    ).toEqual([{ slug: 'reader' }]);
  });

  it('scopes turns through their agent', async () => {
    expect(
      await readRows(client, {
        table: 'turns',
        columns: ['prompt', 'input_tokens'],
      }),
    ).toEqual([{ prompt: 'mine', input_tokens: 12 }]);
  });

  it('scopes events and returns json payloads as values', async () => {
    expect(
      await readRows(client, { table: 'events', columns: ['kind', 'payload'] }),
    ).toEqual([{ kind: 'agent.status', payload: { text: 'hi' } }]);
  });

  it('cannot reach another project by filtering on its ids', async () => {
    expect(
      await readRows(client, {
        table: 'agents',
        filters: [{ column: 'id', value: seeded.otherAgentId }],
      }),
    ).toEqual([]);
  });

  it('returns every readable column by default and none outside the allowlist', async () => {
    const [agent] = await readRows(client, { table: 'agents' });

    expect(Object.keys(agent ?? {})).toEqual([
      'id',
      'voyage_id',
      'name',
      'role',
      'runtime',
      'status',
      'worktree_path',
      'created_at',
      'updated_at',
      'ended_at',
    ]);
  });

  it('applies filters, order and limit', async () => {
    const rows = await readRows(client, {
      table: 'tickets',
      columns: ['title', 'status'],
      filters: [{ column: 'status', op: 'in', value: ['open', 'done'] }],
      order: [{ column: 'title', direction: 'desc' }],
      limit: 1,
    });

    expect(rows).toEqual([{ title: 'QD4c report', status: 'done' }]);
  });

  it.each([
    [[{ column: 'status', value: 'assigned' }], ['QD4b ask 100%']],
    [
      [{ column: 'status', op: 'neq', value: 'done' }],
      ['QD4a bus read', 'QD4b ask 100%'],
    ],
    [
      [{ column: 'assignee_id', op: 'is_null' }],
      ['QD4a bus read', 'QD4c report'],
    ],
    [[{ column: 'assignee_id', op: 'not_null' }], ['QD4b ask 100%']],
    [[{ column: 'title', op: 'contains', value: 'BUS' }], ['QD4a bus read']],
    [[{ column: 'title', op: 'contains', value: '100%' }], ['QD4b ask 100%']],
    [[{ column: 'title', op: 'contains', value: '_' }], []],
  ])('filters tickets by %j', async (filters, titles) => {
    const rows = await readRows(client, {
      table: 'tickets',
      columns: ['title'],
      filters,
      order: [{ column: 'title' }],
    });

    expect(rows.map((row) => row.title)).toEqual(titles);
  });

  it('filters uuid arrays with contains', async () => {
    const rows = await readRows(client, {
      table: 'tickets',
      columns: ['title', 'depends_on'],
      filters: [
        { column: 'depends_on', op: 'contains', value: seeded.ticketIds[0] },
      ],
    });

    expect(rows).toEqual([
      { title: 'QD4b ask 100%', depends_on: [seeded.ticketIds[0]] },
    ]);
  });

  it('compares timestamps and numbers', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();

    expect(
      await readRows(client, {
        table: 'tickets',
        filters: [{ column: 'created_at', op: 'gt', value: future }],
      }),
    ).toEqual([]);
    expect(
      await readRows(client, {
        table: 'turns',
        columns: ['seq'],
        filters: [{ column: 'input_tokens', op: 'gte', value: 12 }],
      }),
    ).toEqual([{ seq: 1 }]);
  });

  it('treats a hostile value as data, not SQL', async () => {
    const rows = await readRows(client, {
      table: 'tickets',
      filters: [{ column: 'title', value: "x' or '1'='1" }],
    });

    expect(rows).toEqual([]);
  });

  it.each([
    [{ table: 'layouts' }, 'table'],
    [{ table: 'schema_migrations' }, 'table'],
    [
      { table: 'agents', columns: ['session_id'] },
      'no readable column session_id',
    ],
    [
      { table: 'agents', columns: ['project_id'] },
      'no readable column project_id',
    ],
    [
      { table: 'tickets', columns: ['title"; drop table tickets; --'] },
      'no readable column',
    ],
    [{ table: 'tickets', columns: ['title', 'title'] }, 'listed twice'],
    [
      {
        table: 'tickets',
        filters: [{ column: 'title) or (true', value: 'x' }],
      },
      'no readable column',
    ],
    [
      {
        table: 'tickets',
        filters: [{ column: 'title', op: 'like', value: 'x' }],
      },
      'op',
    ],
    [
      {
        table: 'tickets',
        filters: [{ column: 'title', op: 'in', value: 'x' }],
      },
      'non-empty array',
    ],
    [
      { table: 'tickets', filters: [{ column: 'title', op: 'in', value: [] }] },
      'non-empty array',
    ],
    [{ table: 'tickets', filters: [{ column: 'title' }] }, 'single value'],
    [
      {
        table: 'tickets',
        filters: [{ column: 'title', op: 'is_null', value: 'x' }],
      },
      'takes no value',
    ],
    [
      {
        table: 'tickets',
        filters: [{ column: 'id', op: 'contains', value: 'x' }],
      },
      'not contains',
    ],
    [
      { table: 'events', filters: [{ column: 'payload', value: '{}' }] },
      'not eq',
    ],
    [
      { table: 'tickets', filters: [{ column: 'id', value: 'not-a-uuid' }] },
      'uuid',
    ],
    [
      { table: 'tickets', order: [{ column: 'depends_on' }] },
      'cannot be ordered',
    ],
    [
      { table: 'tickets', order: [{ column: 'title; drop table tickets' }] },
      'no readable column',
    ],
    [{ table: 'tickets', limit: READ_LIMIT_MAX + 1 }, 'limit'],
    [{ table: 'tickets', limit: 0 }, 'limit'],
    [{ table: 'tickets', columns: ['constructor'] }, 'no readable column'],
    [{ table: 'tickets', columns: ['__proto__'] }, 'no readable column'],
    [
      { table: 'tickets', order: [{ column: 'toString' }] },
      'no readable column',
    ],
    [
      { table: 'tickets', filters: [{ column: '__proto__', op: 'is_null' }] },
      'no readable column',
    ],
    [
      { table: 'tickets', filters: [{ column: 'hasOwnProperty', value: 'x' }] },
      'no readable column',
    ],
  ])('rejects %j', async (args, message) => {
    const reply = await callTool(client, 'read', args);

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(message);
  });

  it('ignores a sql argument instead of running it', async () => {
    const rows = await readRows(client, {
      table: 'projects',
      columns: ['slug'],
      sql: 'delete from tickets',
    });

    expect(rows).toEqual([{ slug: 'reader' }]);
  });

  it('leaves the tables intact after hostile input', async () => {
    const { rows } = await store.db.query<{ count: number }>(
      'select count(*)::int as count from tickets',
    );

    expect(rows[0]?.count).toBe(4);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'refuses %s as a table name',
    (table) => {
      expect(() =>
        buildReadQuery(seeded.agentId, {
          table: table as ReadTableName,
          limit: 1,
        }),
      ).toThrow(`${table} is not a readable table`);
    },
  );
});

describe('bus read reply cap', () => {
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = await openTestStore('capped');
    const agentId = await insertAgent(store, store.projectId, 'okapi');
    const body = 'x'.repeat(READ_REPLY_MAX_BYTES / 2);
    for (const title of ['one', 'two', 'three'])
      await store.db.query(
        'insert into tickets (project_id, title, body) values ($1, $2, $3)',
        [store.projectId, title, body],
      );
    client = await connectClient(store, agentId);
  }, TIMEOUT);

  afterAll(async () => {
    await client.close();
    await store.close();
  });

  it('refuses a reply over the byte cap and says how to narrow it', async () => {
    const reply = await callTool(client, 'read', { table: 'tickets' });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(
      `over the ${READ_REPLY_MAX_BYTES}-byte reply cap; narrow your columns`,
    );
  });

  it('serves the same rows once the columns are narrowed', async () => {
    expect(
      await readRows(client, {
        table: 'tickets',
        columns: ['title'],
        order: [{ column: 'title' }],
      }),
    ).toEqual([{ title: 'one' }, { title: 'three' }, { title: 'two' }]);
  });
});
