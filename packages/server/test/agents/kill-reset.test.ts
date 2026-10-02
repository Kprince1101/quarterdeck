import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_RESET_EVENT,
  AgentFinishedError,
  PROCESS_SWEPT_EVENT,
  createAgentLifecycle,
  trackAgentProcess,
  type AgentLifecycle,
} from '../../src/agents/index.js';
import type { Store } from '../../src/store/index.js';
import {
  GRACE_MS,
  IS_WINDOWS,
  exitOf,
  giveProcess,
  startSleeper,
  stopSleepers,
  storedPid,
} from '../lifecycle/fixtures.js';
import {
  CLEAR_ROUND_TABLES,
  eventPayloads,
  insertAgent,
  lenientSessions,
} from '../round-end/fixtures.js';
import { TIMEOUT, fakeWorktrees, openTestStore } from './fixtures.js';

describe('kill, reset and retire', { timeout: TIMEOUT }, () => {
  let store: Store;
  let sessions: ReturnType<typeof lenientSessions>;
  let lifecycle: AgentLifecycle;

  beforeAll(async () => {
    store = await openTestStore('deck');
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    stopSleepers();
    await store.db.exec(CLEAR_ROUND_TABLES);
  });

  const setUp = () => {
    sessions = lenientSessions();
    lifecycle = createAgentLifecycle({
      naming: { theme: 'birds', names: ['lark'] },
      sessions,
      worktrees: fakeWorktrees(),
      openStores: () => [store],
      killGraceMs: GRACE_MS,
    });
  };

  const agentRow = async (agentId: string) => {
    const { rows } = await store.db.query<{
      status: string;
      sessionId: string | null;
      ended: boolean;
    }>(
      `select status, session_id as "sessionId", ended_at is not null as ended
       from agents where id = $1`,
      [agentId],
    );
    return rows[0];
  };

  it('kills a running agent: closes its session and marks it killed', async () => {
    setUp();
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'working',
      sessionId: 'session-wren',
    });

    const killed = await lifecycle.kill(store, agentId, { intentId: 'i-1' });

    expect(killed.status).toBe('killed');
    expect(sessions.closed).toEqual(['session-wren']);
    expect(await agentRow(agentId)).toEqual({
      status: 'killed',
      sessionId: 'session-wren',
      ended: true,
    });
    expect(await eventPayloads(store, 'agent.killed')).toEqual([
      {
        name: 'wren',
        sessionId: 'session-wren',
        sweep: 'none',
        intentId: 'i-1',
      },
    ]);
  });

  it.each(['ended', 'killed', 'retired'])(
    'refuses to kill an agent that is %s',
    async (status) => {
      setUp();
      const agentId = await insertAgent(store, { name: 'wren', status });

      await expect(lifecycle.kill(store, agentId)).rejects.toBeInstanceOf(
        AgentFinishedError,
      );
      expect(sessions.closed).toEqual([]);
      expect((await agentRow(agentId))?.status).toBe(status);
    },
  );

  it.skipIf(IS_WINDOWS)(
    'SIGTERMs the recorded process group when the host does not know the session',
    async () => {
      setUp();
      const sleeper = await startSleeper();
      const agentId = await insertAgent(store, {
        name: 'wren',
        status: 'working',
        sessionId: 'lost-session',
      });
      await giveProcess(store, agentId, sleeper);

      await lifecycle.kill(store, agentId);

      expect(await exitOf(sleeper)).toEqual([null, 'SIGTERM']);
      expect(await storedPid(store, agentId)).toBeNull();
      expect(await eventPayloads(store, PROCESS_SWEPT_EVENT)).toEqual([
        {
          name: 'wren',
          pid: sleeper.pid,
          reason: 'kill',
          outcome: 'terminated',
        },
      ]);
      expect(await eventPayloads(store, 'agent.killed')).toEqual([
        { name: 'wren', sessionId: 'lost-session', sweep: 'terminated' },
      ]);
    },
  );

  it.skipIf(IS_WINDOWS)(
    'sweeps survivors that ignore SIGTERM with SIGKILL',
    async () => {
      setUp();
      const sleeper = await startSleeper({ ignoreSigterm: true });
      const agentId = await insertAgent(store, { name: 'wren' });
      await giveProcess(store, agentId, sleeper);

      await lifecycle.kill(store, agentId);

      expect(await exitOf(sleeper)).toEqual([null, 'SIGKILL']);
      expect(await eventPayloads(store, PROCESS_SWEPT_EVENT)).toEqual([
        { name: 'wren', pid: sleeper.pid, reason: 'kill', outcome: 'killed' },
      ]);
    },
  );

  it('still sweeps and stays killed when closing the session fails', async () => {
    setUp();
    sessions.close = () => Promise.reject(new Error('connection stuck'));
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'idle',
      sessionId: 'session-wren',
    });

    await expect(lifecycle.kill(store, agentId)).rejects.toThrow(
      'connection stuck',
    );
    expect((await agentRow(agentId))?.status).toBe('killed');
    expect(await eventPayloads(store, 'agent.killed')).toEqual([]);
  });

  it.each([
    ['working', 'idle'],
    ['stuck', 'idle'],
    ['idle', 'idle'],
    ['paused', 'paused'],
    ['killed', 'killed'],
  ])(
    'resets a %s agent: drops its session and leaves it %s',
    async (status, after) => {
      setUp();
      const agentId = await insertAgent(store, {
        name: 'wren',
        status,
        sessionId: 'session-wren',
      });

      const reset = await lifecycle.reset(store, agentId, { intentId: 'i-2' });

      expect(reset).toMatchObject({ status: after, sessionId: null });
      expect(sessions.closed).toEqual(['session-wren']);
      expect(await eventPayloads(store, AGENT_RESET_EVENT)).toEqual([
        {
          name: 'wren',
          sessionId: 'session-wren',
          sweep: 'none',
          intentId: 'i-2',
        },
      ]);
    },
  );

  it('refuses to reset a retired agent', async () => {
    setUp();
    const agentId = await insertAgent(store, {
      name: 'wren',
      status: 'retired',
    });
    await expect(lifecycle.reset(store, agentId)).rejects.toBeInstanceOf(
      AgentFinishedError,
    );
  });

  it.skipIf(IS_WINDOWS)(
    'retire frees the name, sweeps the process and carries the intent',
    async () => {
      setUp();
      const sleeper = await startSleeper();
      const agentId = await insertAgent(store, {
        name: 'wren',
        status: 'killed',
        sessionId: 'session-wren',
      });
      await giveProcess(store, agentId, sleeper);

      const retired = await lifecycle.retire(store, agentId, {
        intentId: 'i-3',
      });

      expect(retired.status).toBe('retired');
      expect(await exitOf(sleeper)).toEqual([null, 'SIGTERM']);
      expect(await eventPayloads(store, PROCESS_SWEPT_EVENT)).toEqual([
        {
          name: 'wren',
          pid: sleeper.pid,
          reason: 'retire',
          outcome: 'terminated',
        },
      ]);
      expect(await eventPayloads(store, 'agent.retired')).toEqual([
        { name: 'wren', intentId: 'i-3' },
      ]);
    },
  );

  it('records the pid an ACP client spawns and forgets it once the group exits', async () => {
    setUp();
    const agentId = await insertAgent(store, { name: 'wren' });
    const errors: unknown[] = [];
    const track = trackAgentProcess(store, agentId, (err) => errors.push(err));
    const dead = 2 ** 22 + 54_321;

    track({ type: 'spawned', pid: dead });
    await expect.poll(() => storedPid(store, agentId)).toBe(dead);
    track({ type: 'exit', code: 0, signal: null });
    await expect.poll(() => storedPid(store, agentId)).toBeNull();
    expect(errors).toEqual([]);
  });
});
