import { RequestError } from '@agentclientprotocol/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SIGNED_IN,
  SIGN_IN_CARD,
  SIGN_IN_COMMANDS,
  SIGN_IN_EVENTS,
  SignInRequiredError,
  withSignIn,
  type SignInGate,
} from '../../src/signin/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

const TIMEOUT = 30_000;

describe('withSignIn', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'signin', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    await store.db.exec(
      'delete from events; delete from cards; delete from tickets; delete from agents;',
    );
  });

  const insertAgent = async (runtime: string): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, runtime, status)
       values ($1, 'wren', 'builder', $2, 'working') returning id`,
      [store.projectId, runtime],
    );
    return rows[0]?.id ?? '';
  };

  const gateFor = async (
    runtime: SignInGate['runtime'],
    extra: Partial<SignInGate> = {},
  ): Promise<SignInGate> => ({
    store,
    agentId: await insertAgent(runtime),
    runtime,
    ...extra,
  });

  const cards = async () => {
    const { rows } = await store.db.query<{
      id: string;
      kind: string;
      ticketId: string | null;
      status: string;
      recommendation: string;
      checked: string;
    }>(
      `select id, kind, ticket_id as "ticketId", status, recommendation, checked
       from cards order by created_at`,
    );
    return rows;
  };

  const eventsOf = async (kind: string) => {
    const { rows } = await store.db.query<{
      ticketId: string | null;
      payload: Record<string, unknown>;
    }>(
      `select ticket_id as "ticketId", payload from events
       where kind = $1 order by id`,
      [kind],
    );
    return rows;
  };

  const nextOpenCard = async () => {
    await expect
      .poll(async () => (await cards()).filter((c) => c.status === 'open'))
      .toHaveLength(1);
    const card = (await cards()).find((c) => c.status === 'open');
    if (!card) throw new Error('no open card');
    return card;
  };

  it('names the exact command for every runtime', () => {
    expect(SIGN_IN_COMMANDS.kiro.command).toBe('kiro-cli login');
    expect(SIGN_IN_COMMANDS.claude.command).toBe('claude /login');
    expect(SIGN_IN_COMMANDS.gemini.command).toBe('gemini');
  });

  it('runs once and raises nothing when the agent is signed in', async () => {
    const gate = await gateFor('kiro');
    let calls = 0;

    const value = await withSignIn(gate, 'session/new', async () => {
      calls += 1;
      return 'opened';
    });

    expect(value).toBe('opened');
    expect(calls).toBe(1);
    expect(await cards()).toEqual([]);
  });

  it('passes any other error through without a card', async () => {
    const gate = await gateFor('kiro');

    await expect(
      withSignIn(gate, 'session/prompt', async () => {
        throw RequestError.internalError(undefined, 'agent crashed');
      }),
    ).rejects.toThrow('agent crashed');
    expect(await cards()).toEqual([]);
  });

  it(
    'files the card under the agent ticket and resumes after the answer',
    async () => {
      const gate = await gateFor('gemini');
      const { rows } = await store.db.query<{ id: string }>(
        `insert into tickets (project_id, assignee_id, title, status)
         values ($1, $2, 'QD9', 'in_progress') returning id`,
        [store.projectId, gate.agentId],
      );
      const ticketId = rows[0]?.id ?? '';
      let calls = 0;

      const running = withSignIn(gate, 'session/prompt', async () => {
        calls += 1;
        if (calls === 1) throw RequestError.authRequired();
        return 'resumed';
      });
      const card = await nextOpenCard();

      expect(card).toMatchObject({
        kind: SIGN_IN_CARD,
        ticketId,
        recommendation: 'gemini',
      });
      expect(card.checked).toContain(
        'session/prompt failed with auth required',
      );
      await store.db.query(
        `update cards set status = 'answered', answer = $2 where id = $1`,
        [card.id, SIGNED_IN],
      );

      expect(await running).toBe('resumed');
      expect(calls).toBe(2);
      expect(await eventsOf(SIGN_IN_EVENTS.required)).toEqual([
        expect.objectContaining({ ticketId }),
      ]);
      expect(await eventsOf(SIGN_IN_EVENTS.resumed)).toEqual([
        {
          ticketId,
          payload: {
            cardId: card.id,
            runtime: 'gemini',
            operation: 'session/prompt',
          },
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    'stops with the command when the card expires',
    async () => {
      const gate = await gateFor('claude', { expiryMs: 100 });

      const failure = await withSignIn(gate, 'session/new', async () => {
        throw RequestError.authRequired();
      }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(SignInRequiredError);
      expect(failure).toMatchObject({
        runtime: 'claude',
        command: 'claude /login',
        status: 'expired',
      });
      expect((failure as Error).message).toContain('`claude /login`');
      expect((await cards()).map((card) => card.status)).toEqual(['expired']);
      expect(await eventsOf(SIGN_IN_EVENTS.resumed)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'stops waiting when the signal aborts and leaves the card open',
    async () => {
      const controller = new AbortController();
      const gate = await gateFor('kiro', { signal: controller.signal });

      const running = withSignIn(gate, 'session/new', async () => {
        throw RequestError.authRequired();
      });
      await nextOpenCard();
      controller.abort();

      await expect(running).rejects.toThrow('the card stays open');
      expect((await cards()).map((card) => card.status)).toEqual(['open']);
    },
    TIMEOUT,
  );
});
