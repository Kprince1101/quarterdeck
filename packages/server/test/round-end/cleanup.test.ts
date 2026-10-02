import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DISCARD_WORKTREE_CARD,
  WorktreeDirtyError,
  createAgentLifecycle,
  type AgentLifecycle,
} from '../../src/agents/index.js';
import { RoundNotFoundError } from '../../src/driver/index.js';
import { ROUND_ENDED_EVENT, cleanUpRound } from '../../src/round-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import { fakeWorktrees, type FakeWorktrees } from '../agents/fixtures.js';
import {
  CLEAR_ROUND_TABLES,
  TIMEOUT,
  eventPayloads,
  insertAgent,
  insertRound,
  lenientSessions,
} from './fixtures.js';

describe('round cleanup', { timeout: TIMEOUT }, () => {
  let store: Store;
  let worktrees: FakeWorktrees;
  let sessions: ReturnType<typeof lenientSessions>;
  let lifecycle: AgentLifecycle;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    await store.db.exec(CLEAR_ROUND_TABLES);
  });

  const setUp = () => {
    worktrees = fakeWorktrees();
    sessions = lenientSessions();
    lifecycle = createAgentLifecycle({
      naming: { theme: 'birds', names: ['lark'] },
      sessions,
      worktrees,
      openStores: () => [store],
      budget: () =>
        Promise.resolve({ hours: 5, capTokens: null, holdAtFraction: 0.8 }),
    });
  };

  const statuses = async (): Promise<Record<string, string>> => {
    const { rows } = await store.db.query<{ name: string; status: string }>(
      'select name, status from agents order by name',
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.status]));
  };

  const roundRow = async (roundId: string) => {
    const { rows } = await store.db.query<{ status: string; ended: boolean }>(
      `select status, ended_at is not null as ended from rounds where id = $1`,
      [roundId],
    );
    return rows[0];
  };

  it("retires the round's Driver and builders, then ends the round", async () => {
    setUp();
    const roundId = await insertRound(store, 4);
    const other = await insertRound(store, 3, 'ended');
    const driver = await insertAgent(store, {
      name: 'lark',
      role: 'driver',
      roundId,
      sessionId: 'driver-session',
    });
    const builder = await insertAgent(store, {
      name: 'pike',
      roundId,
      sessionId: 'pike-session',
      worktreePath: '/wt/pike-1',
    });
    await insertAgent(store, { name: 'thimble', role: 'reviewer', roundId });
    await insertAgent(store, { name: 'okapi', roundId: other });

    const cleanup = await cleanUpRound({
      store,
      lifecycle,
      roundId,
      reason: 'settled',
    });

    expect(cleanup).toEqual({
      roundId,
      round: 4,
      ended: true,
      retired: [driver, builder],
      discardCards: [],
    });
    expect(await statuses()).toEqual({
      lark: 'retired',
      okapi: 'idle',
      pike: 'retired',
      thimble: 'idle',
    });
    expect(sessions.closed).toEqual(['driver-session', 'pike-session']);
    expect(worktrees.removed).toEqual([{ path: '/wt/pike-1', force: false }]);
    expect(await roundRow(roundId)).toEqual({ status: 'ended', ended: true });
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toEqual([
      {
        roundId,
        round: 4,
        reason: 'settled',
        retired: [driver, builder],
        discardCards: [],
      },
    ]);
  });

  it('raises a discard card for a dirty worktree and still ends the round', async () => {
    setUp();
    const roundId = await insertRound(store, 1);
    const builder = await insertAgent(store, {
      name: 'pike',
      roundId,
      worktreePath: '/wt/pike-1',
    });
    worktrees.failNext(new WorktreeDirtyError('/wt/pike-1', ' M src/a.ts'));

    const cleanup = await cleanUpRound({
      store,
      lifecycle,
      roundId,
      reason: 'settled',
    });

    expect(cleanup.retired).toEqual([]);
    expect(cleanup.ended).toBe(true);
    const { rows } = await store.db.query<{ id: string; agentId: string }>(
      `select id, agent_id as "agentId" from cards where kind = $1`,
      [DISCARD_WORKTREE_CARD],
    );
    expect(rows).toEqual([{ id: cleanup.discardCards[0], agentId: builder }]);
    expect(await statuses()).toEqual({ pike: 'idle' });
  });

  it('is safe to run again and does not end a round twice', async () => {
    setUp();
    const roundId = await insertRound(store, 2);
    await cleanUpRound({ store, lifecycle, roundId, reason: 'settled' });

    const again = await cleanUpRound({
      store,
      lifecycle,
      roundId,
      reason: 'settled',
    });

    expect(again.ended).toBe(false);
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toHaveLength(1);
  });

  it('refuses a round outside the project', async () => {
    setUp();
    await expect(
      cleanUpRound({
        store,
        lifecycle,
        roundId: crypto.randomUUID(),
        reason: 'settled',
      }),
    ).rejects.toBeInstanceOf(RoundNotFoundError);
  });
});
