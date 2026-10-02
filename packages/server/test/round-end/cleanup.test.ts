import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DISCARD_WORKTREE_CARD,
  WorktreeDirtyError,
  createAgentLifecycle,
  type AgentLifecycle,
} from '../../src/agents/index.js';
import { RoundNotFoundError } from '../../src/driver/index.js';
import {
  CARD_EXPIRED_EVENT,
  ROUND_ENDED_EVENT,
  TICKET_REOPENED_EVENT,
  cleanUpRound,
  killRound,
  releaseRound,
} from '../../src/round-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import { fakeWorktrees, type FakeWorktrees } from '../agents/fixtures.js';
import {
  CLEAR_ROUND_TABLES,
  TIMEOUT,
  eventPayloads,
  insertAgent,
  insertCard,
  insertRound,
  insertTicket,
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
    });
  };

  const statuses = async (): Promise<Record<string, string>> => {
    const { rows } = await store.db.query<{ name: string; status: string }>(
      'select name, status from agents order by name',
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.status]));
  };

  const cardStatuses = async (): Promise<Record<string, string>> => {
    const { rows } = await store.db.query<{ id: string; status: string }>(
      'select id, status from cards',
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
  };

  const ticketRows = async () => {
    const { rows } = await store.db.query<{
      id: string;
      status: string;
      assigneeId: string | null;
    }>('select id, status, assignee_id as "assigneeId" from tickets');
    return Object.fromEntries(
      rows.map(({ id, status, assigneeId }) => [id, { status, assigneeId }]),
    );
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
      closedCards: [],
      retired: [builder, driver],
      discardCards: [],
      reopened: [],
    });
    expect(await statuses()).toEqual({
      lark: 'retired',
      okapi: 'idle',
      pike: 'retired',
      thimble: 'idle',
    });
    expect(sessions.closed).toEqual(['pike-session', 'driver-session']);
    expect(worktrees.removed).toEqual([{ path: '/wt/pike-1', force: false }]);
    expect(await roundRow(roundId)).toEqual({ status: 'ended', ended: true });
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toEqual([
      {
        roundId,
        round: 4,
        reason: 'settled',
        closedCards: [],
        retired: [builder, driver],
        discardCards: [],
        reopened: [],
      },
    ]);
  });

  it("closes the round's agents' open cards, and leaves other cards and discard cards open", async () => {
    setUp();
    const roundId = await insertRound(store, 5);
    const driver = await insertAgent(store, {
      name: 'lark',
      role: 'driver',
      roundId,
    });
    const builder = await insertAgent(store, { name: 'pike', roundId });
    const reviewer = await insertAgent(store, {
      name: 'thimble',
      role: 'reviewer',
    });
    const ask = await insertCard(store, { agentId: builder });
    const signIn = await insertCard(store, { agentId: driver, kind: 'signin' });
    const answered = await insertCard(store, {
      agentId: builder,
      status: 'answered',
    });
    const discard = await insertCard(store, {
      agentId: builder,
      kind: DISCARD_WORKTREE_CARD,
    });
    const reviewers = await insertCard(store, { agentId: reviewer });
    const human = await insertCard(store);

    const cleanup = await cleanUpRound({
      store,
      lifecycle,
      roundId,
      reason: 'ended',
    });

    expect(cleanup.closedCards.toSorted()).toEqual([ask, signIn].toSorted());
    expect(await cardStatuses()).toEqual(
      Object.fromEntries([
        [ask, 'expired'],
        [signIn, 'expired'],
        [answered, 'answered'],
        [discard, 'open'],
        [reviewers, 'open'],
        [human, 'open'],
      ]),
    );
    const expired = await eventPayloads(store, CARD_EXPIRED_EVENT);
    expect(expired).toHaveLength(2);
    expect(expired[0]).toMatchObject({ roundId, reason: 'ended' });
    expect(cleanup.retired).toEqual([driver]);
    expect(cleanup.discardCards).toEqual([]);
    expect(await statuses()).toMatchObject({ pike: 'idle', thimble: 'idle' });
  });

  it('kills a round: reopens only the tickets its own builders hold', async () => {
    setUp();
    const roundId = await insertRound(store, 6);
    const other = await insertRound(store, 7);
    const builder = await insertAgent(store, { name: 'pike', roundId });
    const gone = await insertAgent(store, {
      name: 'wren',
      roundId,
      status: 'retired',
    });
    const outsider = await insertAgent(store, {
      name: 'okapi',
      roundId: other,
    });
    const assigned = await insertTicket(store, 'assigned', builder);
    const inReview = await insertTicket(store, 'in_review', gone);
    const bounced = await insertTicket(store, 'bounced', builder);
    const done = await insertTicket(store, 'done', builder);
    const elsewhere = await insertTicket(store, 'in_progress', outsider);
    const unassigned = await insertTicket(store, 'open');
    const mergeCard = await insertCard(store, { ticketId: inReview });

    const cleanup = await killRound({ store, lifecycle, roundId });

    expect(cleanup.ended).toBe(true);
    expect(cleanup.reopened.toSorted()).toEqual(
      [assigned, inReview, bounced].toSorted(),
    );
    expect(await ticketRows()).toEqual(
      Object.fromEntries([
        [assigned, { status: 'open', assigneeId: null }],
        [inReview, { status: 'open', assigneeId: null }],
        [bounced, { status: 'open', assigneeId: null }],
        [done, { status: 'done', assigneeId: builder }],
        [elsewhere, { status: 'in_progress', assigneeId: outsider }],
        [unassigned, { status: 'open', assigneeId: null }],
      ]),
    );
    expect(await cardStatuses()).toEqual({ [mergeCard]: 'expired' });
    const reopenedEvents = await eventPayloads(store, TICKET_REOPENED_EVENT);
    expect(reopenedEvents).toContainEqual({
      roundId,
      previousStatus: 'in_review',
      previousAssigneeId: gone,
    });
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toEqual([
      expect.objectContaining({ reason: 'killed', retired: [builder] }),
    ]);
    expect(await statuses()).toMatchObject({ okapi: 'idle', pike: 'retired' });
  });

  it('does not raise a second discard card for a builder already waiting on one', async () => {
    setUp();
    const roundId = await insertRound(store, 8);
    await insertAgent(store, {
      name: 'pike',
      roundId,
      worktreePath: '/wt/pike-1',
    });
    worktrees.failNext(new WorktreeDirtyError('/wt/pike-1', ' M src/a.ts'));
    const released = await releaseRound({
      store,
      lifecycle,
      roundId,
      reason: 'ended',
    });
    expect(released.discardCards).toHaveLength(1);

    const cleanup = await cleanUpRound({
      store,
      lifecycle,
      roundId,
      reason: 'ended',
    });

    expect(cleanup.discardCards).toEqual([]);
    expect(cleanup.ended).toBe(true);
    const { rows } = await store.db.query(
      'select id from cards where kind = $1',
      [DISCARD_WORKTREE_CARD],
    );
    expect(rows).toHaveLength(1);
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
