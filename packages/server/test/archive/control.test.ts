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
  DISCARD_WORKTREE_CARD,
  NamesExhaustedError,
  WorktreeDirtyError,
  attachWorktree,
  createAgentLifecycle,
  type AgentLifecycle,
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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-archive-'));
    errors = [];
    sessions = fakeSessions();
    worktrees = fakeWorktrees();
    lifecycle = createAgentLifecycle({
      naming: PAIR,
      sessions,
      worktrees,
      openStores: () => [deck, yard],
      budget: () =>
        Promise.resolve({ hours: 5, capTokens: null, holdAtFraction: 0.8 }),
      random: () => 0,
    });
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
});
