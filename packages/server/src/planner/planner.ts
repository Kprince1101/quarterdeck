import { homedir } from 'node:os';
import { getErrorMessage, loadRule } from '@quarterdeck/rules';
import type { CardHuman } from '../acp/permissions/index.js';
import { createAgentLifecycle, gitWorktrees } from '../agents/index.js';
import {
  publishEvent,
  type PublishInput,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import { decisionsNote, openingPrompt } from './brief.js';
import {
  PLANNER_FAILED_EVENT,
  cancelTurn,
  runTurn,
  startConversation,
  type Conversation,
  type PlannerContext,
} from './conversation.js';
import {
  PLANNER_INTENT_KINDS,
  PLANNER_NEW,
  decidedProposals,
  livePlannerIds,
  pendingPlannerIntents,
  projectSite,
  settleIntent,
  settleIntents,
  type PlannerIntent,
} from './rows.js';
import {
  PLANNER_ADAPTERS,
  type PlannerAdapters,
  type PlannerBus,
} from './sessions.js';

export const PLANNER_CLEARED_EVENT = 'planner.cleared';

export const NO_REPO_PATH =
  "Set the project's repository path before talking to the Planner.";

export const SUPERSEDED = 'superseded by a new conversation';

export type ClearReason = 'new' | 'failed' | 'restart' | 'shutdown';

export interface PlannerOptions {
  store: Store;
  bus: PlannerBus;
  openStores: () => readonly Store[];
  adapters?: PlannerAdapters;
  homeDir?: string;
  cardHuman?: CardHuman;
  onError?: (err: unknown) => void;
}

export interface Planner {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

const refuseCards: CardHuman = () => Promise.resolve('deny');

const reportError = (err: unknown): void => {
  console.error(err);
};

const clearedEvent = (
  reason: ClearReason,
  intentId: string | null,
  agentId: string | undefined,
): PublishInput => {
  const event: PublishInput = {
    kind: PLANNER_CLEARED_EVENT,
    payload: { reason, intentId },
  };
  if (agentId !== undefined) event.agentId = agentId;
  return event;
};

const retireLeftovers = async (ctx: PlannerContext): Promise<void> => {
  const leftovers = await livePlannerIds(ctx.store.db, ctx.store.projectId);
  if (leftovers.length === 0) return;
  const lifecycle = createAgentLifecycle({
    naming: await loadRule('naming', { homeDir: ctx.homeDir }),
    sessions: {
      open: () => Promise.reject(new Error('leftover Planners never reopen')),
      close: () => Promise.resolve(),
    },
    worktrees: gitWorktrees,
    openStores: ctx.openStores,
  });
  await leftovers.reduce(async (previous, agentId) => {
    await previous;
    await lifecycle.retire(ctx.store, agentId);
    await ctx.store.publish(clearedEvent('restart', null, agentId));
  }, Promise.resolve());
};

export const startPlanner = async (
  options: PlannerOptions,
): Promise<Planner> => {
  const { store } = options;
  const onError = options.onError ?? reportError;
  const ctx: PlannerContext = {
    store,
    bus: options.bus,
    adapters: options.adapters ?? PLANNER_ADAPTERS,
    cardHuman: options.cardHuman ?? refuseCards,
    homeDir: options.homeDir ?? homedir(),
    openStores: options.openStores,
  };
  let conversation: Conversation | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const refuse = (intent: PlannerIntent, error: string): Promise<void> =>
    store.db.transaction(async (tx) => {
      if (!(await settleIntent(tx, intent.id, 'rejected', { error }))) return;
      await publishEvent(tx, store.projectId, {
        kind: PLANNER_FAILED_EVENT,
        payload: { intentId: intent.id, error },
      });
    });

  const endConversation = async (
    reason: ClearReason,
    intentId: string | null = null,
  ): Promise<void> => {
    const ending = conversation;
    conversation = undefined;
    if (ending) await ending.lifecycle.retire(store, ending.agent.id);
    if (!ending && intentId === null) return;
    await store.publish(clearedEvent(reason, intentId, ending?.agent.id));
  };

  const composePrompt = async (
    active: Conversation,
    text: string,
  ): Promise<string> => {
    if (active.turns === 0) return openingPrompt(active.charter, text);
    const decided = await decidedProposals(
      store.db,
      store.projectId,
      active.agent.id,
    );
    const fresh = decided.filter(
      ({ ticketId }) => !active.reported.has(ticketId),
    );
    fresh.forEach(({ ticketId }) => active.reported.add(ticketId));
    return `${decisionsNote(fresh)}${text}`;
  };

  const ensureConversation = async (
    intent: PlannerIntent,
  ): Promise<Conversation | undefined> => {
    if (conversation) return conversation;
    const site = await projectSite(store.db, store.projectId);
    if (site.repoPath === null) {
      await refuse(intent, NO_REPO_PATH);
      return undefined;
    }
    try {
      conversation = await startConversation(ctx, {
        slug: site.slug,
        repoPath: site.repoPath,
      });
      return conversation;
    } catch (err) {
      await refuse(intent, getErrorMessage(err));
      return undefined;
    }
  };

  const handleMessage = async (intent: PlannerIntent): Promise<void> => {
    const active = await ensureConversation(intent);
    if (!active) return;
    try {
      await runTurn(
        ctx,
        active,
        intent,
        await composePrompt(active, intent.text ?? ''),
      );
    } catch (err) {
      await endConversation('failed');
      await refuse(intent, getErrorMessage(err));
    }
  };

  const handleNew = async (intent: PlannerIntent): Promise<void> => {
    await endConversation('new', intent.id);
    await settleIntent(store.db, intent.id, 'applied', {});
  };

  const handle = async (intent: PlannerIntent): Promise<void> => {
    try {
      if (intent.kind === PLANNER_NEW) await handleNew(intent);
      else await handleMessage(intent);
    } catch (err) {
      onError(err);
      await refuse(intent, getErrorMessage(err));
    }
  };

  const drainPending = async (): Promise<void> => {
    if (closing) return;
    const pending = await pendingPlannerIntents(store.db, store.projectId);
    const nextIndex = Math.max(
      pending.findLastIndex((intent) => intent.kind === PLANNER_NEW),
      0,
    );
    const next = pending[nextIndex];
    if (!next) return;
    const superseded = pending.slice(0, nextIndex).map((intent) => intent.id);
    await settleIntents(store.db, superseded, 'rejected', {
      error: SUPERSEDED,
    });
    await handle(next);
    return drainPending();
  };

  const loop = async (): Promise<void> => {
    again = false;
    try {
      await drainPending();
    } catch (err) {
      running = undefined;
      throw err;
    }
    if (again) return loop();
    running = undefined;
  };

  const drain = (): Promise<void> => {
    again = true;
    running ??= loop();
    return running;
  };

  const onEvent = (event: StoreEvent): void => {
    if (!PLANNER_INTENT_KINDS.includes(event.kind)) return;
    if (event.kind === PLANNER_NEW && conversation)
      cancelTurn(conversation).catch(onError);
    drain().catch(onError);
  };

  await retireLeftovers(ctx);
  const subscription = await store.subscribe(onEvent, { onError });
  drain().catch(onError);

  const shutdown = async (): Promise<void> => {
    closing = true;
    await subscription.close();
    if (conversation) await cancelTurn(conversation).catch(onError);
    await running?.catch(() => undefined);
    await endConversation('shutdown');
  };
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= shutdown();
    return closed;
  };

  return { drain, close };
};
