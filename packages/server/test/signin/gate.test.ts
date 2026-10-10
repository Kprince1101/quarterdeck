import { RequestError } from '@agentclientprotocol/sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  SignInDriver,
  SignInOutcome,
  SignInProgress,
} from '../../src/acp/auth/index.js';
import {
  RETRY_SIGN_IN,
  SIGNED_IN,
  SIGN_IN_CARD,
  SIGN_IN_EVENTS,
  SignInRequiredError,
  withSignIn,
  type SignInGate,
} from '../../src/signin/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import { CLAUDE_LOGIN, CLAUDE_TERMINAL_COMMAND } from './auth-methods.js';

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

  let agents = 0;

  const insertAgent = async (runtime: string): Promise<string> => {
    agents += 1;
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, runtime, status)
       values ($1, $2, 'builder', $3, 'working') returning id`,
      [store.projectId, `wren-${agents}`, runtime],
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
      question: string;
      recommendation: string;
      checked: string;
    }>(
      `select id, kind, ticket_id as "ticketId", status, question,
              recommendation, checked
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

  const answer = (cardId: string) =>
    store.db.query(
      `update cards set status = 'answered', answer = $2 where id = $1`,
      [cardId, SIGNED_IN],
    );

  const nextOpenCard = async () => {
    await expect
      .poll(async () => (await cards()).filter((c) => c.status === 'open'))
      .toHaveLength(1);
    const card = (await cards()).find((c) => c.status === 'open');
    if (!card) throw new Error('no open card');
    return card;
  };

  const signedOut = async (): Promise<never> => {
    throw RequestError.authRequired();
  };

  it(
    'puts the command the agent advertises for terminal sign-in on the card',
    async () => {
      const gate = await gateFor('claude', {
        authMethods: () => [CLAUDE_LOGIN],
      });
      let calls = 0;

      const running = withSignIn(gate, 'session/new', async () => {
        calls += 1;
        if (calls === 1) return signedOut();
        return 'opened';
      });
      const card = await nextOpenCard();

      expect(card.recommendation).toBe(CLAUDE_TERMINAL_COMMAND);
      expect(card.question).toContain(`\`${CLAUDE_TERMINAL_COMMAND}\``);
      expect(
        (await eventsOf(SIGN_IN_EVENTS.required))[0]?.payload,
      ).toMatchObject({ command: CLAUDE_TERMINAL_COMMAND });
      await answer(card.id);
      expect(await running).toBe('opened');
    },
    TIMEOUT,
  );

  it(
    'has every waiting agent of one runtime wait on the one open card',
    async () => {
      const first = await gateFor('kiro');
      const second = await gateFor('kiro');
      const other = await gateFor('gemini');
      const attempts = new Map<string, number>();
      const run = (gate: SignInGate) =>
        withSignIn(gate, 'session/prompt', async () => {
          const seen = (attempts.get(gate.agentId) ?? 0) + 1;
          attempts.set(gate.agentId, seen);
          if (seen === 1) return signedOut();
          return gate.agentId;
        });

      const waiting = run(first);
      const card = await nextOpenCard();
      const joining = run(second);
      const separate = run(other);
      await expect
        .poll(async () => (await eventsOf(SIGN_IN_EVENTS.required)).length)
        .toBe(3);

      const open = (await cards()).filter((row) => row.status === 'open');
      expect(open).toHaveLength(2);
      expect(
        (await eventsOf(SIGN_IN_EVENTS.required)).map(
          (event) => event.payload['cardId'],
        ),
      ).toEqual([card.id, card.id, expect.not.stringMatching(card.id)]);
      expect(await eventsOf('card.asked')).toHaveLength(2);

      await answer(card.id);
      expect(await waiting).toBe(first.agentId);
      expect(await joining).toBe(second.agentId);
      const gemini = open.find((row) => row.id !== card.id);
      await answer(gemini?.id ?? '');
      expect(await separate).toBe(other.agentId);
    },
    TIMEOUT,
  );

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
        command: 'claude auth login',
        status: 'expired',
      });
      expect((failure as Error).message).toContain('`claude auth login`');
      expect((await cards()).map((card) => card.status)).toEqual(['expired']);
      expect(await eventsOf(SIGN_IN_EVENTS.resumed)).toEqual([]);
    },
    TIMEOUT,
  );

  describe('with a sign-in driver', () => {
    const signInState = async (cardId: string) => {
      const { rows } = await store.db.query<{
        sign_in: SignInProgress | null;
        options: string[];
        status: string;
        answer: string | null;
      }>('select sign_in, options, status, answer from cards where id = $1', [
        cardId,
      ]);
      return rows[0];
    };

    const succeeding = (): SignInDriver =>
      vi.fn<SignInDriver>(async (options) => {
        options?.onProgress?.({ status: 'starting' });
        options?.onProgress?.({
          status: 'waiting',
          url: 'https://github.com/login/device',
          code: 'ABCD-1234',
        });
        return { ok: true, via: 'gh auth login --web' };
      });

    it(
      'runs the runtime sign-in itself, shows its code on the card and resumes',
      async () => {
        const driver = succeeding();
        const opened: string[] = [];
        const gate = await gateFor('claude', {
          authMethods: () => [CLAUDE_LOGIN],
          signIn: () => driver,
          openUrl: (url) => {
            opened.push(url);
            return Promise.resolve();
          },
        });
        let calls = 0;

        const value = await withSignIn(gate, 'session/new', async () => {
          calls += 1;
          if (calls === 1) return signedOut();
          return 'opened';
        });

        expect(value).toBe('opened');
        expect(driver).toHaveBeenCalledTimes(1);
        expect(driver).toHaveBeenCalledWith(
          expect.objectContaining({ tty: false }),
        );
        const [card] = await cards();
        expect(card).toMatchObject({
          kind: SIGN_IN_CARD,
          question: 'Sign in to Claude Code',
          recommendation: CLAUDE_TERMINAL_COMMAND,
        });
        expect(await signInState(card?.id ?? '')).toEqual({
          sign_in: {
            status: 'signed_in',
            url: 'https://github.com/login/device',
            code: 'ABCD-1234',
          },
          options: [],
          status: 'answered',
          answer: SIGNED_IN,
        });
        expect(
          (await eventsOf(SIGN_IN_EVENTS.resumed))[0]?.payload,
        ).toMatchObject({ via: 'gh auth login --web' });
      },
      TIMEOUT,
    );

    it(
      'falls back to the command card with why, and Retry runs the sign-in again',
      async () => {
        let attempts = 0;
        const driver = vi.fn<SignInDriver>(async () => {
          attempts += 1;
          if (attempts === 1) {
            return { ok: false, reason: 'gh exited with 1: no browser' };
          }
          return { ok: true, via: 'gh auth login --web' };
        });
        const gate = await gateFor('kiro', { signIn: () => driver });
        let calls = 0;

        const running = withSignIn(gate, 'session/prompt', async () => {
          calls += 1;
          if (calls <= 2) return signedOut();
          return 'resumed';
        });
        await expect
          .poll(async () => (await cards())[0]?.checked)
          .toBe('Automatic sign-in failed: gh exited with 1: no browser');
        const card = await nextOpenCard();
        expect(card.question).toContain('Quarterdeck could not sign you in');
        expect(card.question).toContain('`kiro-cli login`');
        expect(card.recommendation).toBe('kiro-cli login');
        expect(await signInState(card.id)).toMatchObject({
          sign_in: {
            status: 'failed',
            message: 'gh exited with 1: no browser',
          },
          options: [RETRY_SIGN_IN, SIGNED_IN],
          status: 'open',
        });

        await store.db.query(
          `update cards set status = 'answered', answer = $2 where id = $1`,
          [card.id, RETRY_SIGN_IN],
        );
        expect(await running).toBe('resumed');
        expect(driver).toHaveBeenCalledTimes(2);
        expect((await cards()).map(({ status }) => status)).toEqual([
          'answered',
          'answered',
        ]);
      },
      TIMEOUT,
    );

    it(
      'does not loop when the runtime still needs sign-in after signing in',
      async () => {
        const driver = succeeding();
        const gate = await gateFor('gemini', { signIn: () => driver });
        let calls = 0;

        const running = withSignIn(gate, 'session/new', async () => {
          calls += 1;
          if (calls <= 2) return signedOut();
          return 'opened';
        });
        await expect
          .poll(async () => (await cards()).find((c) => c.status === 'open'))
          .toMatchObject({
            checked:
              'Automatic sign-in failed: Gemini CLI signed in but still answered auth required',
          });
        expect(driver).toHaveBeenCalledTimes(1);
        const card = await nextOpenCard();
        await answer(card.id);
        expect(await running).toBe('opened');
      },
      TIMEOUT,
    );

    it(
      'stops the sign-in and the request when the card is declined',
      async () => {
        let stopped: string | undefined;
        const driver = vi.fn<SignInDriver>(
          (options) =>
            new Promise((resolve) => {
              options?.signal?.addEventListener('abort', () => {
                stopped = 'aborted';
                resolve({ ok: false, reason: 'cancelled' });
              });
            }),
        );
        const gate = await gateFor('claude', { signIn: () => driver });

        const running = withSignIn(gate, 'session/new', async () =>
          signedOut(),
        ).catch((err: unknown) => err);
        const card = await nextOpenCard();
        await store.db.query(
          `update cards set status = 'declined' where id = $1`,
          [card.id],
        );

        const failure = await running;
        expect(failure).toBeInstanceOf(SignInRequiredError);
        expect(failure).toMatchObject({ status: 'declined' });
        expect(stopped).toBe('aborted');
      },
      TIMEOUT,
    );

    it(
      'has a second agent wait on the card a running sign-in owns',
      async () => {
        let finish: (outcome: SignInOutcome) => void = () => {};
        const driver = vi.fn<SignInDriver>(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const first = await gateFor('kiro', { signIn: () => driver });
        const second = await gateFor('kiro', { signIn: () => driver });
        const seen = new Map<string, number>();
        const run = (gate: SignInGate) =>
          withSignIn(gate, 'session/new', async () => {
            const count = (seen.get(gate.agentId) ?? 0) + 1;
            seen.set(gate.agentId, count);
            if (count === 1) return signedOut();
            return gate.agentId;
          });

        const waiting = run(first);
        await nextOpenCard();
        const joining = run(second);
        await expect
          .poll(async () => (await eventsOf(SIGN_IN_EVENTS.required)).length)
          .toBe(2);
        finish({ ok: true, via: 'kiro-cli login' });

        expect(await waiting).toBe(first.agentId);
        expect(await joining).toBe(second.agentId);
        expect(driver).toHaveBeenCalledTimes(1);
      },
      TIMEOUT,
    );
  });

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
