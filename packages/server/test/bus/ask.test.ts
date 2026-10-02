import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ASK_CARD,
  awaitCard,
  expireCard,
  raiseAskCard,
  type BusTool,
} from '../../src/bus/index.js';
import type { Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  callTool,
  connectClient,
  insertAgent,
  openTestStore,
  readRows,
} from './fixtures.ts';

interface CardRow {
  id: string;
  agent_id: string;
  ticket_id: string | null;
  kind: string;
  question: string;
  options: unknown;
  checked: string;
  recommendation: string;
  status: string;
  answer: string | null;
  created_at: Date;
  expires_at: Date;
}

interface EventRow {
  kind: string;
  agent_id: string | null;
  ticket_id: string | null;
  payload: unknown;
}

const ASK = {
  question: 'Drop the legacy table?',
  options: ['yes', 'no'],
  checked: 'Nothing reads it since QD2a.',
  recommendation: 'yes',
};

const HOUR = 60 * 60 * 1000;

describe('bus ask', () => {
  let store: Store;
  let agentId = '';
  const clients: Client[] = [];

  const connect = async (askExpiryMs?: number): Promise<Client> => {
    const client = await connectClient(store, agentId, undefined, askExpiryMs);
    clients.push(client);
    return client;
  };

  const cards = async (): Promise<CardRow[]> => {
    const { rows } = await store.db.query<CardRow>(
      'select * from cards order by created_at',
    );
    return rows;
  };

  const openCard = async (): Promise<CardRow> =>
    vi.waitFor(
      async () => {
        const [card] = await cards();
        if (card?.status !== 'open') throw new Error('no open card yet');
        return card;
      },
      { timeout: 5000, interval: 10 },
    );

  const settle = async (
    cardId: string,
    status: 'answered' | 'declined',
    answer: string | null,
  ): Promise<void> => {
    await store.db.query(
      `update cards set status = $2, answer = $3, answered_at = now()
       where id = $1`,
      [cardId, status, answer],
    );
  };

  const events = async (): Promise<EventRow[]> => {
    const { rows } = await store.db.query<EventRow>(
      `select kind, agent_id, ticket_id, payload from events
       where kind like 'card.%' order by id`,
    );
    return rows;
  };

  beforeAll(async () => {
    store = await openTestStore('ask');
    agentId = await insertAgent(store, store.projectId, 'okapi');
  }, TIMEOUT);

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  });

  beforeEach(async () => {
    await store.db.exec(
      'delete from events; delete from cards; delete from tickets',
    );
  });

  afterAll(async () => {
    await store.close();
  });

  it(
    'raises a card, waits for the answer and returns it',
    async () => {
      const client = await connect();
      const reply = callTool(client, 'ask', ASK);

      const card = await openCard();
      expect(card).toMatchObject({
        agent_id: agentId,
        ticket_id: null,
        kind: ASK_CARD,
        question: ASK.question,
        options: ASK.options,
        checked: ASK.checked,
        recommendation: ASK.recommendation,
        answer: null,
      });
      const expiresIn = card.expires_at.getTime() - card.created_at.getTime();
      expect(expiresIn).toBe(HOUR);

      await settle(card.id, 'answered', 'no');

      expect(await reply).toEqual({
        text: JSON.stringify({
          cardId: card.id,
          status: 'answered',
          answer: 'no',
        }),
        isError: false,
      });
      expect(await events()).toEqual([
        {
          kind: 'card.asked',
          agent_id: agentId,
          ticket_id: null,
          payload: { cardId: card.id },
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    "ties the card to the caller's active ticket",
    async () => {
      const { rows } = await store.db.query<{ id: string }>(
        `insert into tickets (project_id, assignee_id, title, status)
         values ($1, $2, 'QD4b', 'in_progress'), ($1, $2, 'QD4a', 'done')
         returning id`,
        [store.projectId, agentId],
      );
      const client = await connect();
      const reply = callTool(client, 'ask', ASK);

      const card = await openCard();
      expect(card.ticket_id).toBe(rows[0]?.id);
      await settle(card.id, 'answered', 'yes');
      await reply;
      expect((await events())[0]?.ticket_id).toBe(rows[0]?.id);
    },
    TIMEOUT,
  );

  it(
    'returns a decline as a result, not an error',
    async () => {
      const client = await connect();
      const reply = callTool(client, 'ask', ASK);

      const card = await openCard();
      await settle(card.id, 'declined', null);

      expect(await reply).toEqual({
        text: JSON.stringify({
          cardId: card.id,
          status: 'declined',
          answer: null,
        }),
        isError: false,
      });
    },
    TIMEOUT,
  );

  it(
    'expires an unanswered card and returns expired',
    async () => {
      const client = await connect(200);
      const reply = await callTool(client, 'ask', ASK);

      const [card] = await cards();
      expect(card?.status).toBe('expired');
      expect(reply).toEqual({
        text: JSON.stringify({
          cardId: card?.id,
          status: 'expired',
          answer: null,
        }),
        isError: false,
      });
      expect((await events()).map((event) => event.kind)).toEqual([
        'card.asked',
        'card.expired',
      ]);
    },
    TIMEOUT,
  );

  it(
    'takes a free-text question when there are no options',
    async () => {
      const client = await connect();
      const reply = callTool(client, 'ask', {
        question: 'Which port should the dashboard use?',
        checked: 'The SPEC does not name one.',
        recommendation: '4100, nothing else uses it',
      });

      const card = await openCard();
      expect(card.options).toEqual([]);
      await settle(card.id, 'answered', '4200');

      expect(JSON.parse((await reply).text)).toMatchObject({ answer: '4200' });
    },
    TIMEOUT,
  );

  it.each([
    ['a blank question', { ...ASK, question: '  ' }],
    ['no checked', { ...ASK, checked: undefined }],
    ['a blank recommendation', { ...ASK, recommendation: ' ' }],
    ['one option', { ...ASK, options: ['yes'] }],
    ['repeated options', { ...ASK, options: ['yes', 'yes'] }],
    [
      'a recommendation that is not an option',
      { ...ASK, recommendation: 'maybe' },
    ],
    ['a question over 500 characters', { ...ASK, question: 'x'.repeat(501) }],
  ])(
    'rejects %s without raising a card',
    async (_label, args) => {
      const client = await connect();
      const reply = await callTool(client, 'ask', args);

      expect(reply.isError).toBe(true);
      expect(await cards()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'stops waiting when the call is cancelled and leaves the card open',
    async () => {
      const client = await connect();
      const controller = new AbortController();
      const reply = client.callTool(
        { name: 'ask', arguments: ASK },
        CallToolResultSchema,
        { signal: controller.signal },
      );

      const card = await openCard();
      controller.abort();

      await expect(reply).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await cards())[0]?.status).toBe('open');
      expect(await events()).toHaveLength(1);
      await settle(card.id, 'answered', 'yes');
    },
    TIMEOUT,
  );

  it(
    'tells the agent how to find its card after a failed call, and read finds it',
    async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const description =
        tools.find((tool) => tool.name === 'ask')?.description ?? '';
      expect(description).toContain('fails or times out');
      expect(description).toContain('cards filtered by your own agent_id');
      expect(description).toContain('card.asked');

      const controller = new AbortController();
      const reply = client.callTool(
        { name: 'ask', arguments: ASK },
        CallToolResultSchema,
        { signal: controller.signal },
      );
      const card = await openCard();
      controller.abort();
      await expect(reply).rejects.toThrow();
      await settle(card.id, 'answered', 'no');

      expect(
        await readRows(client, {
          table: 'cards',
          columns: ['id', 'status', 'answer'],
          filters: [{ column: 'agent_id', value: agentId }],
        }),
      ).toEqual([{ id: card.id, status: 'answered', answer: 'no' }]);
      expect(
        await readRows(client, {
          table: 'events',
          columns: ['payload'],
          filters: [
            { column: 'kind', value: 'card.asked' },
            { column: 'agent_id', value: agentId },
          ],
        }),
      ).toEqual([{ payload: { cardId: card.id } }]);
    },
    TIMEOUT,
  );

  it(
    'sends progress notifications to a caller that asked for them',
    async () => {
      const ticking: BusTool = {
        name: 'tick',
        description: 'ticks twice',
        input: { n: z.number().optional() },
        run: async (call) => {
          await call.progress('first');
          await call.progress('second');
          return 'done';
        },
      };
      const client = await connectClient(store, agentId, [ticking]);
      clients.push(client);
      const notes: { progress: number; message?: string | undefined }[] = [];

      const reply = await client.callTool(
        { name: 'tick', arguments: {} },
        CallToolResultSchema,
        {
          onprogress: ({ progress, message }) =>
            notes.push({ progress, message }),
        },
      );

      expect(reply.content).toEqual([{ type: 'text', text: 'done' }]);
      expect(notes).toEqual([
        { progress: 1, message: 'first' },
        { progress: 2, message: 'second' },
      ]);
    },
    TIMEOUT,
  );

  describe('awaitCard', () => {
    const raise = async (expiryMs = HOUR) =>
      raiseAskCard(store, agentId, ASK, expiryMs);

    it(
      'returns at once for a card answered before the wait began',
      async () => {
        const { cardId } = await raise();
        await settle(cardId, 'answered', 'yes');

        expect(
          await awaitCard(store, cardId, {
            expiryMs: HOUR,
            signal: new AbortController().signal,
          }),
        ).toEqual({ cardId, status: 'answered', answer: 'yes' });
      },
      TIMEOUT,
    );

    it(
      'calls onWaiting on every tick until the card settles',
      async () => {
        const { cardId } = await raise();
        let ticks = 0;
        const outcome = awaitCard(store, cardId, {
          expiryMs: HOUR,
          signal: new AbortController().signal,
          progressMs: 10,
          onWaiting: async () => {
            ticks += 1;
            if (ticks === 3) await settle(cardId, 'declined', null);
          },
        });

        expect(await outcome).toEqual({
          cardId,
          status: 'declined',
          answer: null,
        });
        expect(ticks).toBeGreaterThanOrEqual(3);
      },
      TIMEOUT,
    );

    it(
      'ignores answers to other cards',
      async () => {
        const mine = await raise();
        const other = await raise();
        const outcome = awaitCard(store, mine.cardId, {
          expiryMs: 300,
          signal: new AbortController().signal,
        });

        await settle(other.cardId, 'answered', 'yes');

        expect(await outcome).toEqual({
          cardId: mine.cardId,
          status: 'expired',
          answer: null,
        });
      },
      TIMEOUT,
    );
  });

  describe('expireCard', () => {
    it(
      'keeps an answer that landed first',
      async () => {
        const { cardId } = await raiseAskCard(store, agentId, ASK, HOUR);
        await settle(cardId, 'answered', 'no');

        expect(await expireCard(store, cardId)).toEqual({
          cardId,
          status: 'answered',
          answer: 'no',
        });
        expect((await events()).map((event) => event.kind)).toEqual([
          'card.asked',
        ]);
      },
      TIMEOUT,
    );
  });
});
