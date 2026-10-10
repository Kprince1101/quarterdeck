import { forgeTerms } from '@quarterdeck/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AcpClient } from '../../src/acp/client/index.js';
import type { Agent, AgentLifecycle } from '../../src/agents/index.js';
import { PROPOSAL_REFUSED_EVENT } from '../../src/bus/tools/propose.js';
import {
  runTurn,
  type Conversation,
  type PlannerContext,
} from '../../src/planner/conversation.js';
import type {
  PlannerAdapters,
  PlannerSession,
  PlannerSessionHost,
} from '../../src/planner/sessions.js';
import {
  IN_MEMORY,
  openStore,
  type Db,
  type Queryable,
  type Store,
} from '../../src/store/index.js';

type DbHook = (call: 'query' | 'transaction', params?: unknown[]) => void;

const hooked = (db: Db, hook: DbHook): Db =>
  new Proxy(db, {
    get: (target, prop) => {
      if (prop === 'query')
        return (sql: string, params?: unknown[]) => {
          hook('query', params);
          return target.query(sql, params);
        };
      if (prop === 'transaction')
        return async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
          const result = await target.transaction(fn);
          hook('transaction');
          return result;
        };
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value === 'function') return value.bind(target) as unknown;
      return value;
    },
  });

const asksForRefusals = (params: unknown[] | undefined): boolean =>
  (params ?? []).some(
    (param) => Array.isArray(param) && param.includes(PROPOSAL_REFUSED_EVENT),
  );

const TIMEOUT = 30_000;

describe('a Planner turn and a cancel', { timeout: TIMEOUT }, () => {
  let store: Store;
  let agent: Agent;
  let ending: AbortController;
  let prompts: string[];
  let hook: DbHook;

  const refuseOnce = async (): Promise<void> => {
    if (prompts.length > 1) return;
    await store.publish({
      kind: PROPOSAL_REFUSED_EVENT,
      agentId: agent.id,
      payload: { title: 'Greet', project: 'example', problems: ['no design'] },
    });
  };

  const client = {
    agent: { protocolVersion: 1, authMethods: [] },
    prompt: async (_sessionId: string, input: unknown) => {
      prompts.push(String(input));
      await refuseOnce();
      return { stopReason: 'end_turn' };
    },
    cancel: () => Promise.resolve(),
    subscribe: () => () => undefined,
  } as unknown as AcpClient;

  const session: PlannerSession = {
    agentId: '',
    sessionId: 'session-1',
    client,
  };

  const conversation = (): Conversation => ({
    agent,
    slug: 'example',
    charter: '',
    terms: forgeTerms('github'),
    mode: 'multi',
    host: { current: () => session } as unknown as PlannerSessionHost,
    lifecycle: {} as AgentLifecycle,
    turns: 0,
    reported: new Set(),
    inTurn: false,
  });

  const context = (): PlannerContext => {
    const watched = {
      ...store,
      db: hooked(store.db, (call, params) => {
        hook(call, params);
      }),
    };
    return {
      store: watched,
      bus: {
        launch: () => Promise.reject(new Error('no bus')),
        revoke: () => undefined,
      },
      adapters: {} as PlannerAdapters,
      cardHumanFor: () => () => Promise.resolve('deny'),
      homeDir: '/nowhere',
      openStores: () => [watched],
      signInSignal: () => ending.signal,
    };
  };

  const run = () =>
    runTurn(
      context(),
      conversation(),
      { id: crypto.randomUUID(), kind: 'planner.message', text: 'greet' },
      'greet',
    );

  const eventKinds = async (): Promise<string[]> => {
    const { rows } = await store.db.query<{ kind: string }>(
      `select kind from events where agent_id = $1 order by id`,
      [agent.id],
    );
    return rows.map(({ kind }) => kind);
  };

  const turns = async () => {
    const { rows } = await store.db.query<{ seq: number; stopReason: string }>(
      `select seq, stop_reason as "stopReason" from turns
       where agent_id = $1 order by seq`,
      [agent.id],
    );
    return rows;
  };

  beforeEach(async () => {
    store = await openStore({ project: 'example', dataDir: IN_MEMORY });
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, 'quill', 'planner', 'idle') returning id`,
      [store.projectId],
    );
    agent = {
      id: rows[0]?.id ?? '',
      projectId: store.projectId,
      voyageId: null,
      name: 'quill',
      role: 'planner',
      runtime: 'kiro',
      status: 'idle',
      sessionId: 'session-1',
      worktreePath: null,
    };
    session.agentId = agent.id;
    ending = new AbortController();
    prompts = [];
    hook = () => undefined;
  }, TIMEOUT);

  afterEach(async () => {
    await store.close();
  });

  it('re-prompts once when nothing cancels the turn', async () => {
    await run();
    expect(prompts).toHaveLength(2);
    expect(await turns()).toEqual([
      { seq: 1, stopReason: 'end_turn' },
      { seq: 2, stopReason: 'end_turn' },
    ]);
  });

  it('sends no re-prompt when a cancel lands while the refusals are read', async () => {
    hook = (call, params) => {
      if (call === 'query' && asksForRefusals(params)) ending.abort();
    };
    await run();
    expect(prompts).toHaveLength(1);
    expect(await turns()).toEqual([{ seq: 1, stopReason: 'end_turn' }]);
    expect(await eventKinds()).not.toContain('planner.missed');
  });

  it('sends no re-prompt when a cancel lands after the re-prompt turn opens', async () => {
    let transactions = 0;
    hook = (call) => {
      if (call !== 'transaction') return;
      transactions += 1;
      if (transactions === 3) ending.abort();
    };
    await run();
    expect(prompts).toHaveLength(1);
    expect(await turns()).toEqual([
      { seq: 1, stopReason: 'end_turn' },
      { seq: 2, stopReason: 'cancelled' },
    ]);
    expect((await eventKinds()).at(-1)).toBe('planner.reply');
  });
});
