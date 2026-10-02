import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { Naming } from '@quarterdeck/rules';
import {
  BIRTH_CANCELLED_EVENT,
  BirthCancelledError,
  DISCARD_WORKTREE_CARD,
  NamesExhaustedError,
  WorktreeDirtyError,
  attachWorktree,
  createAgentLifecycle,
  type Agent,
  type AgentLifecycle,
  type SessionHost,
} from '../../src/agents/index.js';
import {
  ARCHIVE_RETIRED_EVENT,
  startArchiveControl,
  type ArchiveControl,
} from '../../src/archive/index.js';
import {
  PauseDroppedError,
  startPauseGate,
  type PauseGate,
} from '../../src/pause/index.js';
import type { Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  clearAgents,
  fakeSessions,
  fakeWorktrees,
  openTestStore,
  type FakeSessions,
  type FakeWorktrees,
} from '../agents/fixtures.js';

const PAIR: Naming = { theme: 'birds', names: ['crane', 'heron'] };
const LAUNCH = { operation: 'launch', label: 'assign: QD9' } as const;
const settle = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });

interface Latch {
  reached: Promise<void>;
  release: () => void;
  pass: () => Promise<void>;
}

const latch = (): Latch => {
  let reach = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    pass: () => {
      reach();
      return released;
    },
  };
};

const latchedSessions = (inner: FakeSessions, wait: Latch): FakeSessions => ({
  ...inner,
  open: async (agent: Agent) => {
    await wait.pass();
    return inner.open(agent);
  },
});

describe('archive control', { timeout: TIMEOUT }, () => {
  let deck: Store;
  let yard: Store;
  let home: string;
  let sessions: FakeSessions;
  let worktrees: FakeWorktrees;
  let lifecycle: AgentLifecycle;
  let control: ArchiveControl;
  let gate: PauseGate;
  let errors: unknown[];

  beforeAll(async () => {
    [deck, yard] = await Promise.all([
      openTestStore('deck'),
      openTestStore('yard'),
    ]);
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all([deck.close(), yard.close()]);
  });

  const lifecycleWith = (host: SessionHost): AgentLifecycle =>
    createAgentLifecycle({
      naming: PAIR,
      sessions: host,
      worktrees,
      openStores: () => [deck, yard],
      budget: () =>
        Promise.resolve({ hours: 5, capTokens: null, holdAtFraction: 0.8 }),
      random: () => 0,
    });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-archive-'));
    errors = [];
    sessions = fakeSessions();
    worktrees = fakeWorktrees();
    lifecycle = lifecycleWith(sessions);
    control = await startArchiveControl({
      store: deck,
      lifecycle,
      onError: (err) => errors.push(err),
    });
    gate = await startPauseGate({
      store: deck,
      home,
      onError: (err) => errors.push(err),
    });
  });

  afterEach(async () => {
    await control.close();
    await gate.close();
    await rm(home, { recursive: true, force: true });
    await Promise.all([clearAgents(deck), clearAgents(yard)]);
    await deck.db.exec('update projects set paused_at = null');
    expect(errors).toEqual([]);
  });

  const archive = async (archived: boolean) => {
    await deck.db.query(
      `update projects set archived_at = case when $2::boolean then now() end
       where id = $1`,
      [deck.projectId, archived],
    );
    await deck.publish({ kind: 'project.archive' });
  };

  const birth = (store: Store) =>
    lifecycle.birth({ store, role: 'builder', runtime: 'kiro' });

  const statuses = async (): Promise<Record<string, string>> => {
    const { rows } = await deck.db.query<{ name: string; status: string }>(
      'select name, status from agents order by created_at',
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.status]));
  };

  const retiredEvents = async () => {
    const { rows } = await deck.db.query<{ payload: unknown }>(
      'select payload from events where kind = $1 order by id',
      [ARCHIVE_RETIRED_EVENT],
    );
    return rows.map((row) => row.payload);
  };

  const discardCard = async (agentId: string) => {
    const { rows } = await deck.db.query<{ id: string; status: string }>(
      `select id, status from cards where agent_id = $1 and kind = $2
       order by created_at desc limit 1`,
      [agentId, DISCARD_WORKTREE_CARD],
    );
    return rows[0];
  };

  const answer = async (cardId: string, reply: string) => {
    await deck.db.query(
      `update cards set status = 'answered', answer = $2, answered_at = now()
       where id = $1`,
      [cardId, reply],
    );
    await deck.publish({ kind: 'card.answer' });
  };

  it('retires every agent of an archived project, frees their names and refuses work', async () => {
    const crane = await birth(deck);
    const heron = await birth(deck);
    await expect(birth(yard)).rejects.toThrow(NamesExhaustedError);
    await deck.db.query(`update agents set status = 'paused' where id = $1`, [
      heron.id,
    ]);

    await archive(true);

    await settle(async () => {
      expect(await statuses()).toEqual({ crane: 'retired', heron: 'retired' });
    });
    expect(sessions.closed).toEqual(['session-crane', 'session-heron']);
    expect(await retiredEvents()).toEqual([
      { retired: [crane.id, heron.id], discardCards: [] },
    ]);
    const run = vi.fn(() => Promise.resolve('ran'));
    await expect(gate.hold(LAUNCH, run)).rejects.toMatchObject({
      name: 'PauseDroppedError',
      reason: 'archived',
    });
    expect(run).not.toHaveBeenCalled();
    expect((await birth(yard)).name).toBe('crane');
  });

  it('restores the project on unarchive without a restart', async () => {
    await birth(deck);
    await archive(true);
    await settle(async () => {
      expect(await statuses()).toEqual({ crane: 'retired' });
    });

    await archive(false);

    expect(await gate.hold(LAUNCH, () => Promise.resolve('ran'))).toBe('ran');
    const reborn = await birth(deck);
    expect(reborn.name).toBe('crane');
    await control.drain();
    expect(await statuses()).toEqual({ crane: 'idle' });
    expect(await retiredEvents()).toHaveLength(1);
  });

  it('drops work held by a pause when the project is archived', async () => {
    await deck.db.query('update projects set paused_at = now() where id = $1', [
      deck.projectId,
    ]);
    const run = vi.fn(() => Promise.resolve('ran'));
    const held = gate.hold(LAUNCH, run);
    await settle(() => {
      expect(gate.held()).toHaveLength(1);
    });

    await archive(true);

    await expect(held).rejects.toBeInstanceOf(PauseDroppedError);
    await expect(held).rejects.toMatchObject({ reason: 'archived' });
    expect(gate.held()).toEqual([]);
    const { rows } = await deck.db.query<{ payload: { reason: string } }>(
      `select payload from events where kind = 'pause.dropped'`,
    );
    expect(rows.map((row) => row.payload.reason)).toEqual(['archived']);
    await archive(false);
    await gate.replay();
    expect(run).not.toHaveBeenCalled();
  });

  it('asks before discarding unsaved work, and retires on yes', async () => {
    const crane = await attachWorktree(deck, await birth(deck), '/wt/crane');
    worktrees.failNext(new WorktreeDirtyError('/wt/crane', ' M index.ts'));

    await archive(true);

    await settle(async () => {
      expect(await discardCard(crane.id)).toMatchObject({ status: 'open' });
    });
    const card = await discardCard(crane.id);
    await control.drain();
    expect(await statuses()).toEqual({ crane: 'ended' });

    await answer(card?.id ?? '', 'yes');

    await settle(async () => {
      expect(await statuses()).toEqual({ crane: 'retired' });
    });
    expect(worktrees.removed).toEqual([{ path: '/wt/crane', force: true }]);
    expect(await retiredEvents()).toEqual([
      { retired: [], discardCards: [card?.id] },
      { retired: [crane.id], discardCards: [] },
    ]);
  });

  it('keeps the agent and its work when the discard is refused', async () => {
    const crane = await attachWorktree(deck, await birth(deck), '/wt/crane');
    worktrees.failNext(new WorktreeDirtyError('/wt/crane', ' M index.ts'));
    await archive(true);
    await settle(async () => {
      expect(await discardCard(crane.id)).toMatchObject({ status: 'open' });
    });

    await answer((await discardCard(crane.id))?.id ?? '', 'no');
    await control.drain();

    expect(await statuses()).toEqual({ crane: 'ended' });
    expect(worktrees.removed).toEqual([]);
    const { rows } = await deck.db.query('select id from cards');
    expect(rows).toHaveLength(1);
  });

  const turnCount = async (): Promise<number> => {
    const { rows } = await deck.db.query<{ n: number }>(
      'select count(*)::int as n from turns',
    );
    return rows[0]?.n ?? -1;
  };

  const cancelledEvents = async () => {
    const { rows } = await deck.db.query<{ payload: unknown }>(
      'select payload from events where kind = $1 order by id',
      [BIRTH_CANCELLED_EVENT],
    );
    return rows.map((row) => row.payload);
  };

  it('keeps an agent retired when the archive lands while its session opens', async () => {
    const opening = latch();
    const slow = latchedSessions(fakeSessions(), opening);
    const birthing = lifecycleWith(slow).birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    await opening.reached;

    await archive(true);
    await control.drain();
    expect(await statuses()).toEqual({ crane: 'retired' });
    opening.release();

    await expect(birthing).rejects.toBeInstanceOf(BirthCancelledError);
    await expect(birthing).rejects.toMatchObject({ reason: 'retired' });
    expect(slow.opened).toEqual(['crane']);
    expect(slow.closed).toEqual(['session-crane']);
    const { rows } = await deck.db.query<{
      status: string;
      sessionId: string | null;
    }>('select status, session_id as "sessionId" from agents');
    expect(rows).toEqual([{ status: 'retired', sessionId: null }]);
    expect(await turnCount()).toBe(0);
    expect(await cancelledEvents()).toEqual([
      { name: 'crane', reason: 'retired', sessionId: 'session-crane' },
    ]);
    expect((await birth(yard)).name).toBe('crane');
  });

  it('removes a worktree prepared after the archive retired the agent, and opens no session', async () => {
    const preparing = latch();
    const birthing = lifecycle.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
      prepare: async (agent) => {
        await preparing.pass();
        return attachWorktree(deck, agent, '/wt/crane');
      },
    });
    await preparing.reached;

    await archive(true);
    await control.drain();
    preparing.release();

    await expect(birthing).rejects.toMatchObject({
      name: 'BirthCancelledError',
      reason: 'retired',
    });
    expect(sessions.opened).toEqual([]);
    expect(worktrees.removed).toEqual([{ path: '/wt/crane', force: false }]);
    const { rows } = await deck.db.query(
      'select status, worktree_path as "worktreePath" from agents',
    );
    expect(rows).toEqual([{ status: 'retired', worktreePath: null }]);
    expect(await cancelledEvents()).toEqual([
      { name: 'crane', reason: 'retired', sessionId: null },
    ]);
  });

  it('cancels a birth that starts after the archive control has passed', async () => {
    await archive(true);
    await control.drain();

    await expect(birth(deck)).rejects.toMatchObject({
      name: 'BirthCancelledError',
      reason: 'archived',
    });
    expect(sessions.opened).toEqual([]);
    expect(await statuses()).toEqual({ crane: 'retired' });
    expect(await cancelledEvents()).toEqual([
      { name: 'crane', reason: 'archived', sessionId: null },
    ]);
  });
});
