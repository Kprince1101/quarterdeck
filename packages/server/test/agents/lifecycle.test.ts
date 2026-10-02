import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadRule, type Naming } from '@quarterdeck/rules';
import type { Store } from '../../src/store/index.js';
import {
  AgentNotFoundError,
  DISCARD_APPROVED,
  DISCARD_WORKTREE_CARD,
  DiscardNotApprovedError,
  NamesExhaustedError,
  WorktreeDirtyError,
  createAgentLifecycle,
  requestWorktreeDiscard,
  type AgentLifecycle,
} from '../../src/agents/index.js';
import {
  TIMEOUT,
  clearAgents,
  fakeSessions,
  fakeWorktrees,
  openTestStore,
  type FakeSessions,
  type FakeWorktrees,
} from './fixtures.js';

const PAIR: Naming = { theme: 'birds', names: ['crane', 'heron'] };

describe('agent lifecycle', () => {
  let deck: Store;
  let yard: Store;
  let sessions: FakeSessions;
  let worktrees: FakeWorktrees;

  beforeAll(async () => {
    [deck, yard] = await Promise.all([
      openTestStore('deck'),
      openTestStore('yard'),
    ]);
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all([deck.close(), yard.close()]);
  });

  afterEach(async () => {
    await Promise.all([clearAgents(deck), clearAgents(yard)]);
  });

  const lifecycle = (naming: Naming): AgentLifecycle => {
    sessions = fakeSessions();
    worktrees = fakeWorktrees();
    return createAgentLifecycle({
      naming,
      sessions,
      worktrees,
      openStores: () => [deck, yard],
      random: () => 0,
    });
  };

  const eventsFor = async (store: Store) => {
    const { rows } = await store.db.query<{ kind: string; payload: unknown }>(
      'select kind, payload from events order by id',
    );
    return rows;
  };

  it('names agents from rules/naming.json', async () => {
    const naming = await loadRule('naming');
    const agent = await lifecycle(naming).birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });

    expect(naming.names).toContain(agent.name);
  });

  it('writes the agent row, opens its session and records the birth', async () => {
    const agent = await lifecycle(PAIR).birth({
      store: deck,
      role: 'reviewer',
      runtime: 'claude',
    });

    expect(agent).toEqual({
      id: expect.any(String),
      projectId: deck.projectId,
      roundId: null,
      name: 'crane',
      role: 'reviewer',
      runtime: 'claude',
      status: 'idle',
      sessionId: 'session-crane',
      worktreePath: null,
    });
    expect(sessions.opened).toEqual(['crane']);
    expect(await eventsFor(deck)).toEqual([
      {
        kind: 'agent.born',
        payload: { name: 'crane', role: 'reviewer', runtime: 'claude' },
      },
    ]);
  });

  it('keeps names unique among live agents across open projects', async () => {
    const agents = lifecycle(PAIR);
    const born = await Promise.all([
      agents.birth({ store: deck, role: 'builder', runtime: 'kiro' }),
      agents.birth({ store: yard, role: 'builder', runtime: 'kiro' }),
    ]);

    expect(born.map((agent) => agent.name).toSorted()).toEqual([
      'crane',
      'heron',
    ]);
    await expect(
      agents.birth({ store: deck, role: 'builder', runtime: 'kiro' }),
    ).rejects.toThrow(NamesExhaustedError);
  });

  it('frees a name once its agent retires or its project is archived', async () => {
    const agents = lifecycle(PAIR);
    const crane = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    await agents.birth({ store: yard, role: 'builder', runtime: 'kiro' });

    await agents.retire(deck, crane.id);
    const reborn = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    expect(reborn.name).toBe('crane');

    await yard.db.query('update projects set archived_at = now()');
    const heron = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    expect(heron.name).toBe('heron');
  });

  it('retires an agent whose session fails to open and frees its name', async () => {
    const agents = lifecycle(PAIR);
    sessions.failNext('kiro-cli is not signed in');

    await expect(
      agents.birth({ store: deck, role: 'builder', runtime: 'kiro' }),
    ).rejects.toThrow('kiro-cli is not signed in');

    const { rows } = await deck.db.query<{ name: string; status: string }>(
      'select name, status from agents',
    );
    expect(rows).toEqual([{ name: 'crane', status: 'retired' }]);
    expect((await eventsFor(deck)).map((event) => event.kind)).toEqual([
      'agent.born',
      'agent.birth_failed',
    ]);
    const retry = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    expect(retry.name).toBe('crane');
  });

  it('reports both errors when a failed birth cannot be retired', async () => {
    const doomed = await openTestStore('doomed');
    const agents = createAgentLifecycle({
      naming: PAIR,
      sessions: {
        open: async () => {
          await doomed.close();
          throw new Error('kiro-cli crashed');
        },
        close: () => Promise.resolve(),
      },
      worktrees: fakeWorktrees(),
      openStores: () => [doomed],
    });

    const failure = await agents
      .birth({ store: doomed, role: 'builder', runtime: 'kiro' })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AggregateError);
    const { errors } = failure as AggregateError;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual(new Error('kiro-cli crashed'));
  });

  const birthWithWorktree = async (agents: AgentLifecycle) => {
    const agent = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    await deck.db.query(
      `update agents set worktree_path = '/tmp/wt/crane', status = 'working'
       where id = $1`,
      [agent.id],
    );
    return agent;
  };

  const agentRow = async (agentId: string) => {
    const { rows } = await deck.db.query<{
      status: string;
      session_id: string | null;
      worktree_path: string | null;
      ended: boolean;
    }>(
      `select status, session_id, worktree_path, ended_at is not null as ended
       from agents where id = $1`,
      [agentId],
    );
    return rows[0];
  };

  it('closes the session and removes the worktree on retire', async () => {
    const agents = lifecycle(PAIR);
    const agent = await birthWithWorktree(agents);

    const retired = await agents.retire(deck, agent.id);

    expect(sessions.closed).toEqual(['session-crane']);
    expect(worktrees.removed).toEqual([
      { path: '/tmp/wt/crane', force: false },
    ]);
    expect(retired).toMatchObject({
      status: 'retired',
      sessionId: null,
      worktreePath: null,
    });
    expect((await agentRow(agent.id))?.ended).toBe(true);
    expect((await eventsFor(deck)).slice(1)).toEqual([
      {
        kind: 'agent.session_closed',
        payload: { name: 'crane', sessionId: 'session-crane' },
      },
      {
        kind: 'agent.worktree_removed',
        payload: {
          name: 'crane',
          worktreePath: '/tmp/wt/crane',
          discarded: false,
        },
      },
      { kind: 'agent.retired', payload: { name: 'crane' } },
    ]);
  });

  it('resumes a retire that failed part way without closing twice', async () => {
    const agents = lifecycle(PAIR);
    const agent = await birthWithWorktree(agents);
    worktrees.failNext(new Error('worktree is locked'));

    await expect(agents.retire(deck, agent.id)).rejects.toThrow(
      'worktree is locked',
    );
    expect(await agentRow(agent.id)).toEqual({
      status: 'ended',
      session_id: null,
      worktree_path: '/tmp/wt/crane',
      ended: true,
    });

    const retired = await agents.retire(deck, agent.id);

    expect(retired.status).toBe('retired');
    expect(sessions.closed).toEqual(['session-crane']);
    expect(worktrees.removed).toEqual([
      { path: '/tmp/wt/crane', force: false },
    ]);
  });

  it('keeps a killed agent killed while its retire is incomplete', async () => {
    const agents = lifecycle(PAIR);
    const agent = await birthWithWorktree(agents);
    await deck.db.query(`update agents set status = 'killed' where id = $1`, [
      agent.id,
    ]);
    worktrees.failNext(new Error('worktree is locked'));

    await expect(agents.retire(deck, agent.id)).rejects.toThrow();
    expect((await agentRow(agent.id))?.status).toBe('killed');
  });

  it('discards unsaved work only after a yes on the discard card', async () => {
    const agents = lifecycle(PAIR);
    const agent = await birthWithWorktree(agents);
    const dirty = new WorktreeDirtyError('/tmp/wt/crane', '?? dirty.txt');
    worktrees.failNext(dirty);

    await expect(agents.retire(deck, agent.id)).rejects.toBe(dirty);
    expect((await agentRow(agent.id))?.worktree_path).toBe('/tmp/wt/crane');

    const cardId = await requestWorktreeDiscard(deck, agent, dirty);
    const { rows: cards } = await deck.db.query<{
      kind: string;
      question: string;
      options: string[];
    }>('select kind, question, options from cards where id = $1', [cardId]);
    expect(cards).toEqual([
      {
        kind: DISCARD_WORKTREE_CARD,
        question:
          "Discard crane's unsaved work in /tmp/wt/crane?\n?? dirty.txt",
        options: [DISCARD_APPROVED, 'no'],
      },
    ]);

    await expect(
      agents.retire(deck, agent.id, { discardCardId: cardId }),
    ).rejects.toThrow(DiscardNotApprovedError);
    await deck.db.query(
      `update cards set status = 'answered', answer = 'no' where id = $1`,
      [cardId],
    );
    await expect(
      agents.retire(deck, agent.id, { discardCardId: cardId }),
    ).rejects.toThrow(DiscardNotApprovedError);
    expect(worktrees.removed).toEqual([]);

    await deck.db.query(`update cards set answer = $2 where id = $1`, [
      cardId,
      DISCARD_APPROVED,
    ]);
    const retired = await agents.retire(deck, agent.id, {
      discardCardId: cardId,
    });

    expect(retired.status).toBe('retired');
    expect(worktrees.removed).toEqual([{ path: '/tmp/wt/crane', force: true }]);
    expect(
      (await eventsFor(deck)).find(
        (event) => event.kind === 'agent.worktree_removed',
      )?.payload,
    ).toEqual({
      name: 'crane',
      worktreePath: '/tmp/wt/crane',
      discarded: true,
    });
  });

  it('refuses a discard card raised for another agent', async () => {
    const agents = lifecycle(PAIR);
    const crane = await birthWithWorktree(agents);
    const heron = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    const cardId = await requestWorktreeDiscard(
      deck,
      heron,
      new WorktreeDirtyError('/tmp/wt/heron', ' M a.ts'),
    );
    await deck.db.query(
      `update cards set status = 'answered', answer = $2 where id = $1`,
      [cardId, DISCARD_APPROVED],
    );

    await expect(
      agents.retire(deck, crane.id, { discardCardId: cardId }),
    ).rejects.toThrow(DiscardNotApprovedError);
  });

  it('leaves the agent live when its session refuses to close', async () => {
    const agents = lifecycle(PAIR);
    const agent = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    sessions.close = () => Promise.reject(new Error('session busy'));

    await expect(agents.retire(deck, agent.id)).rejects.toThrow('session busy');
    const { rows } = await deck.db.query<{ status: string }>(
      'select status from agents where id = $1',
      [agent.id],
    );
    expect(rows).toEqual([{ status: 'idle' }]);
  });

  it('treats retiring a retired agent as done', async () => {
    const agents = lifecycle(PAIR);
    const agent = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });
    await agents.retire(deck, agent.id);
    const again = await agents.retire(deck, agent.id);

    expect(again.status).toBe('retired');
    expect(sessions.closed).toEqual(['session-crane']);
  });

  it('only retires agents of the store it is given', async () => {
    const agents = lifecycle(PAIR);
    const agent = await agents.birth({
      store: deck,
      role: 'builder',
      runtime: 'kiro',
    });

    await expect(agents.retire(yard, agent.id)).rejects.toThrow(
      AgentNotFoundError,
    );
  });
});
