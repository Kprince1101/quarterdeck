import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  callTool,
  connectClient,
  insertAgent,
  openTestStore,
} from './fixtures.ts';

const insertPlanner = async (
  store: Store,
  status = 'idle',
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into agents (project_id, name, role, status)
     values ($1, $2, 'planner', $3) returning id`,
    [store.projectId, `wren-${crypto.randomUUID()}`, status],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('planner not stored');
  return id;
};

const proposedId = (text: string): string => {
  const match = /^proposed ([0-9a-f-]{36})$/.exec(text);
  if (!match?.[1]) throw new Error(`unexpected reply: ${text}`);
  return match[1];
};

describe('bus propose', () => {
  let store: Store;
  let plannerId = '';
  let planner: Client;
  const clients: Client[] = [];

  const connect = async (agentId: string): Promise<Client> => {
    const client = await connectClient(store, agentId);
    clients.push(client);
    return client;
  };

  const insertTicket = async (status: string): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title, status)
       values ($1, $2, $2) returning id`,
      [store.projectId, status],
    );
    return rows[0]?.id ?? '';
  };

  beforeAll(async () => {
    store = await openTestStore('propose');
    plannerId = await insertPlanner(store);
    planner = await connect(plannerId);
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await store.close();
  });

  beforeEach(async () => {
    await store.db.exec('delete from events; delete from tickets');
  });

  it('stores a proposed ticket and records who proposed it', async () => {
    const reply = await callTool(planner, 'propose', {
      title: '  QD5b Planner  ',
      body: 'Conversation per project.',
    });
    expect(reply.isError).toBe(false);
    const ticketId = proposedId(reply.text);
    const { rows } = await store.db.query(
      `select title, body, status, depends_on, source from tickets
       where id = $1`,
      [ticketId],
    );
    expect(rows).toEqual([
      {
        title: 'QD5b Planner',
        body: 'Conversation per project.',
        status: 'proposed',
        depends_on: [],
        source: 'local',
      },
    ]);
    const events = await store.db.query(
      'select kind, agent_id, ticket_id, payload from events',
    );
    expect(events.rows).toEqual([
      {
        kind: 'ticket.proposed',
        agent_id: plannerId,
        ticket_id: ticketId,
        payload: { title: 'QD5b Planner' },
      },
    ]);
  });

  it('lets a proposal depend on other proposals and open tickets', async () => {
    const first = proposedId(
      (await callTool(planner, 'propose', { title: 'store' })).text,
    );
    const open = await insertTicket('open');
    const second = proposedId(
      (
        await callTool(planner, 'propose', {
          title: 'api',
          dependsOn: [first, open],
        })
      ).text,
    );
    const { rows } = await store.db.query(
      'select depends_on from tickets where id = $1',
      [second],
    );
    expect(rows).toEqual([{ depends_on: [first, open] }]);
  });

  it('refuses dependencies that do not exist or will never be built', async () => {
    const missing = crypto.randomUUID();
    expect(
      await callTool(planner, 'propose', { title: 'x', dependsOn: [missing] }),
    ).toEqual({
      text: `dependsOn names tickets that do not exist: ${missing}`,
      isError: true,
    });
    const rejected = await insertTicket('rejected');
    expect(
      await callTool(planner, 'propose', { title: 'x', dependsOn: [rejected] }),
    ).toEqual({
      text: `dependsOn names tickets that will never be built: ${rejected} (rejected)`,
      isError: true,
    });
    const { rows } = await store.db.query(
      `select count(*)::int as n from tickets where status = 'proposed'`,
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('is refused to every agent but a live Planner', async () => {
    const builder = await connect(
      await insertAgent(store, store.projectId, `okapi-${crypto.randomUUID()}`),
    );
    expect(await callTool(builder, 'propose', { title: 'x' })).toEqual({
      text: 'only the Planner can propose tickets',
      isError: true,
    });
    const ended = await connect(await insertPlanner(store, 'ended'));
    expect(await callTool(ended, 'propose', { title: 'x' })).toEqual({
      text: 'this conversation has ended',
      isError: true,
    });
    const { rows } = await store.db.query(
      'select count(*)::int as n from tickets',
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('rejects a blank title', async () => {
    const reply = await callTool(planner, 'propose', { title: '   ' });
    expect(reply.isError).toBe(true);
  });
});
