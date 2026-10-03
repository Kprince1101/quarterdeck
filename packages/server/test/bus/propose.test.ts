import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TICKET_SPEC_FORMAT } from '../../src/planner/index.js';
import type { Store } from '../../src/store/index.js';
import {
  FAKE_BODY_WITHOUT_DESIGN,
  FAKE_SPEC_BODY,
} from '../acp/fake-agent/index.ts';
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

  const propose = (client: Client, args: Record<string, unknown>) =>
    callTool(client, 'propose', {
      project: 'propose',
      body: FAKE_SPEC_BODY,
      ...args,
    });

  it('stores a proposed ticket and records who proposed it', async () => {
    const reply = await propose(planner, { title: '  QD5b Planner  ' });
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
        body: FAKE_SPEC_BODY,
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
        payload: { title: 'QD5b Planner', project: 'propose', ticketId },
      },
    ]);
  });

  it('lets a proposal depend on other proposals and open tickets', async () => {
    const first = proposedId((await propose(planner, { title: 'store' })).text);
    const open = await insertTicket('open');
    const second = proposedId(
      (await propose(planner, { title: 'api', dependsOn: [first, open] })).text,
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
      await propose(planner, { title: 'x', dependsOn: [missing] }),
    ).toEqual({
      text: `dependsOn names tickets that do not exist: ${missing}`,
      isError: true,
    });
    const rejected = await insertTicket('rejected');
    expect(
      await propose(planner, { title: 'x', dependsOn: [rejected] }),
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
    const refused = {
      text: 'only the Planner can propose tickets',
      isError: true,
    };
    expect(await propose(builder, { title: 'x' })).toEqual(refused);
    expect(await callTool(builder, 'propose', { title: 'x' })).toEqual(refused);
    const ended = await connect(await insertPlanner(store, 'ended'));
    expect(await propose(ended, { title: 'x' })).toEqual({
      text: 'this conversation has ended',
      isError: true,
    });
    const { rows } = await store.db.query(
      'select count(*)::int as n from tickets',
    );
    expect(rows).toEqual([{ n: 0 }]);
    const events = await store.db.query(
      'select count(*)::int as n from events',
    );
    expect(events.rows).toEqual([{ n: 0 }]);
  });

  it('refuses a body that is not a spec, records why and stores nothing', async () => {
    const reply = await propose(planner, {
      title: 'Greeting',
      body: FAKE_BODY_WITHOUT_DESIGN,
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(
      'Nothing was proposed: the proposal does not follow the proposal format: it has no `## Design` section. Fix the proposal and propose the ticket again.',
    );
    expect(reply.text).toContain(TICKET_SPEC_FORMAT);
    expect(
      (await propose(planner, { title: 'Blank', body: '' })).text,
    ).toContain('it has no `## Requirements` section');
    const { rows } = await store.db.query(
      'select count(*)::int as n from tickets',
    );
    expect(rows).toEqual([{ n: 0 }]);
    const events = await store.db.query(
      'select kind, agent_id, ticket_id, payload from events order by id',
    );
    expect(events.rows[0]).toEqual({
      kind: 'planner.proposal_refused',
      agent_id: plannerId,
      ticket_id: null,
      payload: {
        title: 'Greeting',
        project: 'propose',
        problems: ['it has no `## Design` section'],
      },
    });
    expect(events.rows).toHaveLength(2);
  });

  it('refuses a proposal that names no project or one that is not active', async () => {
    const unnamed = await propose(planner, { title: 'x', project: '' });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.text).toContain(
      'it names no project; name one of `propose`',
    );
    const unknown = await propose(planner, { title: 'x', project: 'sample' });
    expect(unknown.text).toContain(
      'it names `sample`, which is not an active project; name one of `propose`',
    );
    const { rows } = await store.db.query(
      'select count(*)::int as n from tickets',
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('accepts its own project before the host lists it as open', async () => {
    const starting = await connectClient(
      store,
      plannerId,
      undefined,
      undefined,
      () => [],
    );
    clients.push(starting);
    const reply = await propose(starting, { title: 'Early' });
    expect(reply.isError).toBe(false);
    const { rows } = await store.db.query(
      'select title, status from tickets where id = $1',
      [proposedId(reply.text)],
    );
    expect(rows).toEqual([{ title: 'Early', status: 'proposed' }]);
  });

  it('stores a proposal in the other open project it names', async () => {
    const other = await openTestStore('sample');
    try {
      const spanning = await connectClient(
        store,
        plannerId,
        undefined,
        undefined,
        () => [store, other],
      );
      clients.push(spanning);
      const reply = await propose(spanning, {
        title: 'Elsewhere',
        project: 'sample',
      });
      expect(reply.isError).toBe(false);
      const ticketId = proposedId(reply.text);
      const there = await other.db.query(
        'select title, status from tickets where id = $1',
        [ticketId],
      );
      expect(there.rows).toEqual([{ title: 'Elsewhere', status: 'proposed' }]);
      const here = await store.db.query(
        'select kind, agent_id, ticket_id, payload from events',
      );
      expect(here.rows).toEqual([
        {
          kind: 'ticket.proposed',
          agent_id: plannerId,
          ticket_id: null,
          payload: { title: 'Elsewhere', project: 'sample', ticketId },
        },
      ]);
      await other.db.query(
        `update projects set archived_at = now() where id = $1`,
        [other.projectId],
      );
      const archived = await propose(spanning, {
        title: 'Archived',
        project: 'sample',
      });
      expect(archived.text).toContain('which is not an active project');
    } finally {
      await other.close();
    }
  });

  it('rejects a blank title', async () => {
    const reply = await propose(planner, { title: '   ' });
    expect(reply.isError).toBe(true);
  });
});
