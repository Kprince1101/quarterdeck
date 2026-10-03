import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { PROCESS_SWEPT_EVENT } from '../../src/agents/index.js';
import { stopProjectAgents } from '../../src/lifecycle/index.js';
import { ARCHIVE_KIND, isProjectArchived } from '../../src/pause/index.js';
import type { Store } from '../../src/store/index.js';
import {
  fakeWorktrees,
  openTestStore,
  type FakeWorktrees,
} from '../agents/fixtures.js';
import {
  CLEAR_VOYAGE_TABLES,
  eventPayloads,
  insertAgent,
  insertTicket,
  lenientSessions,
} from '../voyage-end/fixtures.js';
import {
  GRACE_MS,
  IS_WINDOWS,
  TIMEOUT,
  exitOf,
  giveProcess,
  startSleeper,
  stopSleepers,
  storedPid,
} from './fixtures.js';

describe('stopping a project before a wipe', { timeout: TIMEOUT }, () => {
  let store: Store;
  let sessions: ReturnType<typeof lenientSessions>;
  let worktrees: FakeWorktrees;

  beforeAll(async () => {
    store = await openTestStore('deck');
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    stopSleepers();
    await store.db.exec(
      `${CLEAR_VOYAGE_TABLES} update projects set archived_at = null;`,
    );
  });

  beforeEach(() => {
    sessions = lenientSessions();
    worktrees = fakeWorktrees();
  });

  const stop = (onError?: (err: unknown) => void) =>
    stopProjectAgents(
      store,
      { sessions, worktrees, killGraceMs: GRACE_MS },
      onError,
    );

  const bornInOrder = (...agentIds: string[]) =>
    store.db.query(
      `update agents a set created_at = now() + o.n * interval '1 second'
       from unnest($1::uuid[]) with ordinality o(id, n)
       where a.id = o.id`,
      [agentIds],
    );

  const statusOf = async (table: string, id: string) => {
    const { rows } = await store.db.query<{ status: string }>(
      `select status from ${table} where id = $1`,
      [id],
    );
    return rows[0]?.status;
  };

  it('archives the project first, so nothing new starts', async () => {
    const stopped = await stop();

    expect(stopped).toEqual({ killed: [], running: [] });
    expect(await isProjectArchived(store.db, store.projectId)).toBe(true);
    expect(await eventPayloads(store, ARCHIVE_KIND)).toEqual([
      { archived: true, reason: 'wipe' },
    ]);
  });

  it('kills every live agent through kill, blocking its tickets', async () => {
    const wren = await insertAgent(store, {
      name: 'wren',
      status: 'working',
      sessionId: 'session-wren',
    });
    const lark = await insertAgent(store, { name: 'lark', status: 'paused' });
    await bornInOrder(wren, lark);
    const ticket = await insertTicket(store, 'in_progress', wren);

    const stopped = await stop();

    expect(stopped).toEqual({ killed: ['wren', 'lark'], running: [] });
    expect(sessions.closed).toEqual(['session-wren']);
    expect(await statusOf('agents', wren)).toBe('killed');
    expect(await statusOf('agents', lark)).toBe('killed');
    expect(await statusOf('tickets', ticket)).toBe('blocked');
    expect(await eventPayloads(store, 'agent.killed')).toHaveLength(2);
  });

  it('leaves finished agents finished and removes every worktree, forced', async () => {
    const ended = await insertAgent(store, {
      name: 'wren',
      status: 'ended',
      worktreePath: '/tmp/qd-wren',
    });
    const lark = await insertAgent(store, {
      name: 'lark',
      status: 'idle',
      worktreePath: '/tmp/qd-lark',
    });
    const kite = await insertAgent(store, { name: 'kite', status: 'retired' });
    await bornInOrder(ended, lark, kite);

    const stopped = await stop();

    expect(stopped).toEqual({ killed: ['lark'], running: [] });
    expect(await statusOf('agents', ended)).toBe('ended');
    expect(worktrees.removed).toEqual([
      { path: '/tmp/qd-wren', force: true },
      { path: '/tmp/qd-lark', force: true },
    ]);
  });

  it('reports a worktree that will not go and carries on', async () => {
    const wren = await insertAgent(store, {
      name: 'wren',
      status: 'idle',
      worktreePath: '/tmp/qd-wren',
    });
    const lark = await insertAgent(store, {
      name: 'lark',
      status: 'idle',
      worktreePath: '/tmp/qd-lark',
    });
    await bornInOrder(wren, lark);
    const errors: unknown[] = [];
    worktrees.failNext(new Error('not a git repository'));

    const stopped = await stop((err) => errors.push(err));

    expect(stopped).toEqual({ killed: ['wren', 'lark'], running: [] });
    expect(errors).toEqual([new Error('not a git repository')]);
    expect(worktrees.removed).toEqual([{ path: '/tmp/qd-lark', force: true }]);
  });

  it.skipIf(IS_WINDOWS)(
    'stops the process group of a live agent and of a finished one left behind',
    async () => {
      const live = await startSleeper();
      const left = await startSleeper({ ignoreSigterm: true });
      const wren = await insertAgent(store, {
        name: 'wren',
        status: 'working',
        sessionId: 'lost-session',
      });
      const lark = await insertAgent(store, { name: 'lark', status: 'ended' });
      await bornInOrder(wren, lark);
      await giveProcess(store, wren, live);
      await giveProcess(store, lark, left);

      const stopped = await stop();

      expect(stopped).toEqual({ killed: ['wren'], running: [] });
      expect(await exitOf(live)).toEqual([null, 'SIGTERM']);
      expect(await exitOf(left)).toEqual([null, 'SIGKILL']);
      expect(await storedPid(store, wren)).toBeNull();
      expect(await storedPid(store, lark)).toBeNull();
      expect(await eventPayloads(store, PROCESS_SWEPT_EVENT)).toEqual([
        { name: 'wren', pid: live.pid, reason: 'kill', outcome: 'terminated' },
        { name: 'lark', pid: left.pid, reason: 'wipe', outcome: 'killed' },
      ]);
    },
  );
});
