import { getErrorMessage } from '@quarterdeck/rules';
import {
  DISCARD_APPROVED,
  WorktreeDirtyError,
  findAgent,
  requestWorktreeDiscard,
  type Agent,
  type AgentLifecycle,
} from '../agents/index.js';
import { settleIntent, type SettledStatus } from '../planner/rows.js';
import {
  publishEvent,
  type PublishInput,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import {
  AGENT_KILL,
  AGENT_RESET,
  AGENT_RETIRE,
  LIFECYCLE_INTENT_KINDS,
  awaitDiscardCard,
  pendingLifecycleIntents,
  readDiscardCard,
  type LifecycleIntent,
  type LifecycleIntentKind,
} from './rows.js';

export const LIFECYCLE_EVENTS = {
  retireHeld: 'agent.retire_held',
  failed: 'agent.intent_failed',
} as const;

export const DISCARD_REFUSED =
  'the worktree discard card was not answered yes; the agent keeps its worktree';

const WAKE_KINDS: readonly string[] = [
  ...LIFECYCLE_INTENT_KINDS,
  'card.answer',
  'card.decline',
  'card.expired',
];

export type IntentLifecycle = Pick<AgentLifecycle, 'kill' | 'retire' | 'reset'>;

export interface LifecycleIntentsOptions {
  store: Store;
  lifecycle: IntentLifecycle;
  onError?: (err: unknown) => void;
}

export interface LifecycleIntents {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

const reportError = (err: unknown): void => {
  console.error(err);
};

export const startLifecycleIntents = async (
  options: LifecycleIntentsOptions,
): Promise<LifecycleIntents> => {
  const { store, lifecycle } = options;
  const onError = options.onError ?? reportError;
  let running: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const settle = (
    intent: LifecycleIntent,
    status: SettledStatus,
    result: Record<string, unknown>,
    notice?: PublishInput,
  ): Promise<void> =>
    store.db.transaction(async (tx) => {
      if (!(await settleIntent(tx, intent.id, status, result))) return;
      if (notice) await publishEvent(tx, store.projectId, notice);
    });

  const applied = (intent: LifecycleIntent, agent: Agent): Promise<void> =>
    settle(intent, 'applied', { status: agent.status });

  const fail = (
    intent: LifecycleIntent,
    error: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> =>
    settle(
      intent,
      'rejected',
      { error, ...extra },
      {
        kind: LIFECYCLE_EVENTS.failed,
        agentId: intent.agentId,
        payload: { intentId: intent.id, intent: intent.kind, error, ...extra },
      },
    );

  const holdRetire = async (
    intent: LifecycleIntent,
    dirty: WorktreeDirtyError,
  ): Promise<void> => {
    const agent = await findAgent(store, intent.agentId);
    const discardCardId = await requestWorktreeDiscard(store, agent, dirty);
    await store.db.transaction(async (tx) => {
      await awaitDiscardCard(tx, intent.id, discardCardId);
      await publishEvent(tx, store.projectId, {
        kind: LIFECYCLE_EVENTS.retireHeld,
        agentId: intent.agentId,
        payload: { intentId: intent.id, discardCardId, path: dirty.path },
      });
    });
  };

  const finishRetire = async (
    intent: LifecycleIntent,
    discardCardId: string,
  ): Promise<void> => {
    const card = await readDiscardCard(
      store.db,
      store.projectId,
      discardCardId,
    );
    if (card?.status === 'open') return;
    if (card?.status !== 'answered' || card.answer !== DISCARD_APPROVED) {
      await fail(intent, DISCARD_REFUSED, { discardCardId });
      return;
    }
    const retired = await lifecycle.retire(store, intent.agentId, {
      intentId: intent.id,
      discardCardId,
    });
    await applied(intent, retired);
  };

  const retire = async (intent: LifecycleIntent): Promise<void> => {
    if (intent.discardCardId !== null)
      return finishRetire(intent, intent.discardCardId);
    try {
      const retired = await lifecycle.retire(store, intent.agentId, {
        intentId: intent.id,
      });
      await applied(intent, retired);
    } catch (err) {
      if (!(err instanceof WorktreeDirtyError)) throw err;
      await holdRetire(intent, err);
    }
  };

  const handlers: Record<
    LifecycleIntentKind,
    (intent: LifecycleIntent) => Promise<void>
  > = {
    [AGENT_KILL]: async (intent) =>
      applied(
        intent,
        await lifecycle.kill(store, intent.agentId, { intentId: intent.id }),
      ),
    [AGENT_RESET]: async (intent) =>
      applied(
        intent,
        await lifecycle.reset(store, intent.agentId, { intentId: intent.id }),
      ),
    [AGENT_RETIRE]: retire,
  };

  const handle = async (intent: LifecycleIntent): Promise<void> => {
    try {
      await handlers[intent.kind](intent);
    } catch (err) {
      await fail(intent, getErrorMessage(err));
    }
  };

  const drainPending = async (): Promise<void> => {
    const pending = await pendingLifecycleIntents(store.db, store.projectId);
    for (const intent of pending) {
      if (closing) return;
      await handle(intent);
    }
  };

  const loop = async (): Promise<void> => {
    again = false;
    try {
      if (!closing) await drainPending();
    } catch (err) {
      running = undefined;
      throw err;
    }
    if (again && !closing) return loop();
    running = undefined;
  };

  const drain = (): Promise<void> => {
    again = true;
    running ??= loop();
    return running;
  };

  const onEvent = (event: StoreEvent): void => {
    if (WAKE_KINDS.includes(event.kind)) drain().catch(onError);
  };

  const subscription = await store.subscribe(onEvent, { onError });
  drain().catch(onError);

  const shutdown = async (): Promise<void> => {
    closing = true;
    await subscription.close();
    await running?.catch(() => undefined);
  };
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= shutdown();
    return closed;
  };

  return { drain, close };
};
