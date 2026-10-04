import { INTENT_NAMES } from '@quarterdeck/server/intents';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import {
  IntentError,
  KEEPALIVE_BODY_LIMIT,
  createIntentClient,
  createIntentSender,
  type IntentInput,
  type IntentReply,
} from '../../src/api/index.js';
import { TIMEOUT, startDeck, type Deck } from './harness.js';

const MISSING = '00000000-0000-4000-8000-000000000000';

const caught = async (promise: Promise<unknown>): Promise<IntentError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IntentError) return err;
    throw err;
  }
  throw new Error('expected an IntentError');
};

const replyWith = (status: number, body: string) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status })));

describe('intent client', () => {
  it('has exactly one function per intent', () => {
    const client = createIntentClient();
    const functions = Object.entries(client).flatMap(([group, actions]) =>
      Object.entries(actions).map(([action, send]) => {
        expect(send).toBeTypeOf('function');
        return `${group}.${action}`;
      }),
    );
    expect(functions.toSorted()).toEqual(INTENT_NAMES.toSorted());
  });

  it('types each function from its intent schema', () => {
    const client = createIntentClient();
    expectTypeOf(client.notebook.add)
      .parameter(0)
      .toEqualTypeOf<IntentInput<'notebook.add'>>();
    expectTypeOf(client.wipe.all)
      .parameter(0)
      .toEqualTypeOf<{ confirm: 'wipe everything' }>();
    expectTypeOf(client.voyage.start).returns.resolves.toEqualTypeOf<
      IntentReply & { intent: 'voyage.start' }
    >();
    expectTypeOf(client.notebook).not.toHaveProperty('start');
  });

  it('posts JSON to the intent path on the page origin by default', async () => {
    const post = replyWith(
      200,
      JSON.stringify({ intent: 'notebook.add', status: 'applied' }),
    );
    const client = createIntentClient({ fetch: post });
    await client.notebook.add({ project: 'deck', body: 'remember this' });
    expect(post).toHaveBeenCalledWith('/api/intents/notebook.add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'deck', body: 'remember this' }),
    });
  });

  it('marks the request keepalive when asked', async () => {
    const post = replyWith(
      200,
      JSON.stringify({ intent: 'layout.reset', status: 'applied' }),
    );
    const client = createIntentClient({ fetch: post });
    const input = { name: 'dashboard', preset: 'ops' as const };
    await client.layout.reset(input, { keepalive: true });
    expect(post).toHaveBeenCalledWith('/api/intents/layout.reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      keepalive: true,
    });
  });

  it('refuses a keepalive body over the browser limit without sending it', async () => {
    const post = vi.fn<typeof fetch>();
    const send = createIntentSender({ fetch: post });
    const body = 'x'.repeat(KEEPALIVE_BODY_LIMIT);
    const err = await caught(
      send('notebook.add', { project: 'deck', body }, { keepalive: true }),
    );
    expect(post).not.toHaveBeenCalled();
    expect(err).toMatchObject({
      intent: 'notebook.add',
      status: 413,
      sent: false,
    });
    expect(err.message).toContain(`at most ${KEEPALIVE_BODY_LIMIT}`);
  });

  it('refuses input the shared schema rejects without sending it', async () => {
    const post = vi.fn<typeof fetch>();
    const client = createIntentClient({ fetch: post });
    const err = await caught(
      client.ticket.update({ project: 'deck', ticketId: MISSING }),
    );
    expect(post).not.toHaveBeenCalled();
    expect(err).toMatchObject({
      intent: 'ticket.update',
      status: 400,
      sent: false,
      message: 'Invalid ticket.update intent',
      issues: [
        { path: [], message: 'ticket.update needs title, body or dependsOn' },
      ],
    });
  });

  it('reports an error reply that is not JSON by its status', async () => {
    const send = createIntentSender({ fetch: replyWith(502, 'Bad gateway') });
    const err = await caught(
      send('pause.set', { project: 'deck', paused: true }),
    );
    expect(err).toMatchObject({
      intent: 'pause.set',
      status: 502,
      sent: true,
      message: 'pause.set failed with HTTP 502',
      issues: undefined,
    });
  });

  describe('against the API server', { timeout: TIMEOUT }, () => {
    let deck: Deck;

    beforeAll(async () => {
      deck = await startDeck('client');
    }, TIMEOUT);

    afterAll(async () => {
      await deck.close();
    });

    it('returns the applied reply', async () => {
      const reply = await deck.client.notebook.add({
        project: deck.project,
        body: 'typed client',
      });
      expect(reply).toMatchObject({
        intent: 'notebook.add',
        status: 'applied',
        id: expect.any(String),
        result: { entryId: expect.any(String) },
      });
    });

    it('returns the pending reply', async () => {
      const reply = await deck.client.project.kill({ project: deck.project });
      expect(reply).toMatchObject({
        intent: 'project.kill',
        status: 'pending',
        id: expect.any(String),
      });
    });

    it('throws the server error with its status', async () => {
      const err = await caught(
        deck.client.card.decline({ project: deck.project, cardId: MISSING }),
      );
      expect(err).toMatchObject({
        intent: 'card.decline',
        status: 404,
        sent: true,
      });
    });

    it('throws for a project that does not exist', async () => {
      const err = await caught(
        deck.client.agent.pause({ project: 'nowhere', agentId: MISSING }),
      );
      expect(err).toMatchObject({ status: 404, sent: true });
    });

    it.each([undefined, 'not-the-token'])(
      'is refused with token %s',
      async (token) => {
        const client = createIntentClient({ baseUrl: deck.api.url, token });
        const err = await caught(
          client.notebook.add({ project: deck.project, body: 'no' }),
        );
        expect(err).toMatchObject({
          intent: 'notebook.add',
          status: 401,
          sent: true,
          message: 'notebook.add failed with HTTP 401',
        });
      },
    );
  });
});
