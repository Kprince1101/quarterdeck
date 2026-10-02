import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_RESET_EVENT,
  DISCARD_WORKTREE_CARD,
  WorktreeDirtyError,
  createAgentLifecycle,
} from '../../src/agents/index.js';
import {
  DISCARD_REFUSED,
  LIFECYCLE_EVENTS,
  startLifecycleIntents,
  type LifecycleIntents,
} from '../../src/lifecycle/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import { fakeWorktrees, type FakeWorktrees } from '../agents/fixtures.js';
import {
  CLEAR_ROUND_TABLES,
  eventPayloads,
  insertAgent,
  lenientSessions,
} from '../round-end/fixtures.js';
import { GRACE_MS, TIMEOUT, noBudgetCap } from './fixtures.js';

type CardReply = 'yes' | 'no' | 'decline';

const CARD_REPLIES: Record<
  CardReply,
  { status: string; answer: string | null; kind: string }
> = {
  yes: { status: 'answered', answer: 'yes', kind: 'card.answer' },
  no: { status: 'answered', answer: 'no', kind: 'card.answer' },
  decline: { status: 'declined', answer: null, kind: 'card.decline' },
};

describe('lifecycle intents', { timeout: TIMEOUT }, () => {
  let store: Store;
  let sessions: ReturnType<typeof lenientSessions>;
  let worktrees: FakeWorktrees;
  let intents: LifecycleIntents | undefined;
  let errors: unknown[];

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    await intents?.close();
    intents = undefined;
    await store.db.exec(`${CLEAR_ROUND_TABLES} delete from intents;`);
  });

  const start = async () => {
    sessions = lenientSessions();
    worktrees = fakeWorktrees();
    errors = [];
    intents = await startLifecycleIntents({
      store,
      lifecycle: createAgentLifecycle({
        naming: { theme: 'birds', names: ['wren'] },
        sessions,
        worktrees,
        openStores: () => [store],
        budget: noBudgetCap,
        killGraceMs: GRACE_MS,
      }),
      onError: (err) => errors.push(err),
    });
    return intents;
  };

  const queue = async (kind: string, agentId: string): Promise<string> =>
    store.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into intents (project_id, kind, input, status)
         values ($1, $2, $3::jsonb, 'pending') returning id`,
        [store.projectId, kind, JSON.stringify({ project: 'deck', agentId })],
      );
      const id = rows[0]?.id ?? '';
      await tx.query(
        `insert into events (project_id, kind, payload)
         values ($1, $2, $3::jsonb)`,
        [
          store.projectId,
          kind,
          JSON.stringify({ intentId: id, status: 'pending' }),
        ],
      );
      return id;
    });

  const intentRow = async (intentId: string) => {
    const { rows } = await store.db.query<{
      status: string;
      result: Record<string, unknown> | null;
    }>('select status, result from intents where id = $1', [intentId]);
    return rows[0];
  };

  const settled = (intentId: string) =>
    expect
      .poll(async () => (await intentRow(intentId))?.status, {
        timeout: 10_000,
      })
      .not.toBe('pending');

  const agentStatus = async (agentId: string) => {
    const { rows } = await store.db.query<{ status: string }>(
      'select status from agents where id = $1',
      [agentId],
    );
    return rows[0]?.status;
  };

  const answerCard = async (cardId: string, reply: CardReply) => {
    const { status, answer, kind } = CARD_REPLIES[reply];
    await store.db.query(
      `update cards set status = $2, answer = $3, answered_at = now()
       where id = $1`,
      [cardId, status, answer],
    );
    await store.publish({
      kind,
      payload: { intentId: crypto.randomUUID(), status: 'applied' },
    });
  };

  it('kills an agent and acks with agent.killed', async () => {
    await start();
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'working',
      sessionId: 'session-wren',
    });

    const intentId = await queue('agent.kill', agentId);
    await settled(intentId);

    expect(await intentRow(intentId)).toEqual({
      status: 'applied',
      result: { status: 'killed' },
    });
    expect(sessions.closed).toEqual(['session-wren']);
    expect(await eventPayloads(store, 'agent.killed')).toEqual([
      { name: 'wren', sessionId: 'session-wren', sweep: 'none', intentId },
    ]);
  });

  it('applies a kill whose session would not close, naming the error', async () => {
    await start();
    sessions.close = () => Promise.reject(new Error('connection stuck'));
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'working',
      sessionId: 'session-wren',
    });

    const intentId = await queue('agent.kill', agentId);
    await settled(intentId);

    expect(await intentRow(intentId)).toEqual({
      status: 'applied',
      result: { status: 'killed' },
    });
    expect(await eventPayloads(store, 'agent.killed')).toEqual([
      {
        name: 'wren',
        sessionId: 'session-wren',
        sweep: 'none',
        closeError: 'connection stuck',
        intentId,
      },
    ]);
  });

  it('resets an agent and acks with agent.session_reset', async () => {
    await start();
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'idle',
      sessionId: 'session-wren',
    });

    const intentId = await queue('agent.reset', agentId);
    await settled(intentId);

    expect(await intentRow(intentId)).toEqual({
      status: 'applied',
      result: { status: 'idle' },
    });
    expect(await eventPayloads(store, AGENT_RESET_EVENT)).toEqual([
      { name: 'wren', sessionId: 'session-wren', sweep: 'none', intentId },
    ]);
  });

  it('retires an agent, freeing its name, and acks with agent.retired', async () => {
    await start();
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'killed',
      worktreePath: '/tmp/wren',
    });

    const intentId = await queue('agent.retire', agentId);
    await settled(intentId);

    expect(await intentRow(intentId)).toEqual({
      status: 'applied',
      result: { status: 'retired' },
    });
    expect(worktrees.removed).toEqual([{ path: '/tmp/wren', force: false }]);
    expect(await eventPayloads(store, 'agent.retired')).toEqual([
      { name: 'wren', intentId },
    ]);
  });

  it('applies intents queued before it started, in order, even within one clock tick', async () => {
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'working',
      sessionId: 'session-wren',
    });
    const kill = await queue('agent.kill', agentId);
    const retire = await queue('agent.retire', agentId);
    await store.db.query(
      'update intents set created_at = (select min(created_at) from intents)',
    );

    await start();
    await settled(retire);

    expect((await intentRow(kill))?.status).toBe('applied');
    expect(await agentStatus(agentId)).toBe('retired');
  });

  it('rejects an intent it cannot apply and says why in agent.intent_failed', async () => {
    await start();
    const agentId = await insertAgent(store, { name: 'wren', status: 'ended' });

    const intentId = await queue('agent.kill', agentId);
    await settled(intentId);

    expect(await intentRow(intentId)).toEqual({
      status: 'rejected',
      result: { error: 'wren is already ended' },
    });
    expect(await eventPayloads(store, LIFECYCLE_EVENTS.failed)).toEqual([
      { intentId, intent: 'agent.kill', error: 'wren is already ended' },
    ]);
    expect(errors).toEqual([]);
  });

  describe('a retire whose worktree holds work', () => {
    const holdRetire = async () => {
      await start();
      const agentId = await insertAgent(store, {
        name: 'wren',
        worktreePath: '/tmp/wren',
      });
      worktrees.failNext(new WorktreeDirtyError('/tmp/wren', ' M a.ts'));
      const intentId = await queue('agent.retire', agentId);
      await expect
        .poll(async () => (await intentRow(intentId))?.result)
        .toHaveProperty('discardCardId');
      const result = (await intentRow(intentId))?.result ?? {};
      return { agentId, intentId, cardId: String(result['discardCardId']) };
    };

    it('stays pending behind a discard card', async () => {
      const { agentId, intentId, cardId } = await holdRetire();

      expect((await intentRow(intentId))?.status).toBe('pending');
      const { rows } = await store.db.query<{ kind: string; agentId: string }>(
        `select kind, agent_id as "agentId" from cards where id = $1`,
        [cardId],
      );
      expect(rows).toEqual([{ kind: DISCARD_WORKTREE_CARD, agentId }]);
      expect(await eventPayloads(store, LIFECYCLE_EVENTS.retireHeld)).toEqual([
        { intentId, discardCardId: cardId, path: '/tmp/wren' },
      ]);
      await intents?.drain();
      expect((await intentRow(intentId))?.status).toBe('pending');
      expect(await agentStatus(agentId)).toBe('idle');
    });

    it('finishes the retire, forcing the removal, once the card says yes', async () => {
      const { agentId, intentId, cardId } = await holdRetire();

      await answerCard(cardId, 'yes');
      await settled(intentId);

      expect(await intentRow(intentId)).toEqual({
        status: 'applied',
        result: { status: 'retired' },
      });
      expect(worktrees.removed).toEqual([{ path: '/tmp/wren', force: true }]);
      expect(await agentStatus(agentId)).toBe('retired');
    });

    it.each<CardReply>(['no', 'decline'])(
      'is rejected on %s and keeps the work',
      async (reply) => {
        const { agentId, intentId, cardId } = await holdRetire();

        await answerCard(cardId, reply);
        await settled(intentId);

        expect(await intentRow(intentId)).toEqual({
          status: 'rejected',
          result: { error: DISCARD_REFUSED, discardCardId: cardId },
        });
        expect(worktrees.removed).toEqual([]);
        expect(await agentStatus(agentId)).toBe('idle');
      },
    );
  });
});
