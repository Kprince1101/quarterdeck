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

interface StatusEvent {
  agent_id: string;
  kind: string;
  payload: { text: string };
}

describe('bus status', () => {
  let store: Store;
  let agentId = '';
  let client: Client;

  const statusEvents = async (): Promise<StatusEvent[]> => {
    const { rows } = await store.db.query<StatusEvent>(
      `select agent_id, kind, payload from events
       where kind = 'agent.status' order by id`,
    );
    return rows;
  };

  beforeAll(async () => {
    store = await openTestStore('status');
    agentId = await insertAgent(store, store.projectId, 'okapi');
    client = await connectClient(store, agentId);
  }, TIMEOUT);

  afterAll(async () => {
    await client.close();
    await store.close();
  });

  beforeEach(async () => {
    await store.db.exec('delete from events');
  });

  it('records the note as an agent.status event for the calling agent', async () => {
    const reply = await callTool(client, 'status', {
      text: 'QD4a: writing tests',
    });

    expect(reply).toEqual({ text: 'noted', isError: false });
    expect(await statusEvents()).toEqual([
      {
        agent_id: agentId,
        kind: 'agent.status',
        payload: { text: 'QD4a: writing tests' },
      },
    ]);
  });

  it('folds whitespace and newlines into one line', async () => {
    await callTool(client, 'status', { text: '  two\n\tlines  here ' });

    expect((await statusEvents())[0]?.payload.text).toBe('two lines here');
  });

  it.each([
    ['blank', '   '],
    ['201-character', 'x'.repeat(201)],
  ])('rejects a %s note without recording it', async (_label, text) => {
    const reply = await callTool(client, 'status', { text });

    expect(reply.isError).toBe(true);
    expect(await statusEvents()).toEqual([]);
  });
});
