import { homedir } from 'node:os';
import { getErrorMessage, loadRule } from '@quarterdeck/rules';
import type { CardHuman } from '../acp/permissions/index.js';
import {
  createAgentLifecycle,
  gitWorktrees,
  type Agent,
} from '../agents/index.js';
import {
  ARCHIVE_KIND,
  PauseDroppedError,
  isProjectArchived,
  pauseLabel,
  type PauseGuard,
  type PauseSubject,
} from '../pause/index.js';
import {
  publishEvent,
  type PublishInput,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import type { WorkspaceMode } from '../stream/schema.js';
import { decisionsNote, openingPrompt } from './brief.js';
import { activeProjects, openProjects } from './projects.js';
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

export const PROJECT_ARCHIVED =
  'The project is archived. Unarchive it before talking to the Planner.';

export type ClearReason =
  'new' | 'failed' | 'restart' | 'shutdown' | 'archived' | 'retired';

export interface PlannerOptions {
  store: Store;
  bus: PlannerBus;
  openStores: () => readonly Store[];
  pause: PauseGuard;
  adapters?: PlannerAdapters;
  homeDir?: string;
  mode?: () => Promise<WorkspaceMode>;
  cardHuman?: CardHuman;
  permissionCards?: PermissionCards;
  onError?: (err: unknown) => void;
}

export type PermissionCards = (agent: Agent, signal: AbortSignal) => CardHuman;

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
    budget: async () =>
      (await loadRule('lifecycle', { homeDir: ctx.homeDir })).budget.window,
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
  let signIn = new AbortController();
  const stopSignInWaits = (): void => {
    signIn.abort();
    signIn = new AbortController();
  };
  const cardHumanFor = (agent: Agent): CardHuman => {
    if (options.permissionCards)
      return options.permissionCards(agent, signIn.signal);
    return options.cardHuman ?? refuseCards;
  };
  const ctx: PlannerContext = {
    store,
    bus: options.bus,
    adapters: options.adapters ?? PLANNER_ADAPTERS,
    cardHumanFor,
    homeDir: options.homeDir ?? homedir(),
    openStores: options.openStores,
    signInSignal: () => signIn.signal,
    mode: options.mode,
  };
  let conversation: Conversation | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let closing = false;
  let holding: AbortController | undefined;

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
    if (ending) {
      await ending.lifecycle.retire(store, ending.agent.id);
      const left = ending.host.current();
      if (left) await ending.host.close(left.sessionId);
    }
    if (!ending && intentId === null) return;
    await store.publish(clearedEvent(reason, intentId, ending?.agent.id));
  };

  const dropStaleConversation = async (): Promise<void> => {
    if (!conversation) return;
    if (await isProjectArchived(store.db, store.projectId)) {
      await endConversation('archived');
      return;
    }
    const live = await livePlannerIds(store.db, store.projectId);
    if (!live.includes(conversation.agent.id)) await endConversation('retired');
  };

  const composePrompt = async (
    active: Conversation,
    text: string,
  ): Promise<string> => {
    const stores = [store, ...ctx.openStores()];
    if (active.turns === 0)
      return openingPrompt(
        active.charter,
        await activeProjects(stores),
        text,
        active.terms,
        active.mode,
      );
    const decided = await decidedProposals(
      store.db,
      {
        projectId: store.projectId,
        slug: active.slug,
        agentId: active.agent.id,
      },
      await openProjects(stores),
    );
    const fresh = decided.filter(
      ({ ticketId }) => !active.reported.has(ticketId),
    );
    fresh.forEach(({ ticketId }) => active.reported.add(ticketId));
    return `${decisionsNote(fresh, active.mode)}${text}`;
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

  const converse = async (intent: PlannerIntent): Promise<void> => {
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

  const handleMessage = async (intent: PlannerIntent): Promise<void> => {
    const stop = new AbortController();
    holding = stop;
    const subject: PauseSubject = {
      operation: 'planner.turn',
      label: pauseLabel('message', intent.text ?? ''),
    };
    if (conversation) subject.agentId = conversation.agent.id;
    try {
      await options.pause.hold(subject, () => converse(intent), {
        signal: stop.signal,
      });
    } catch (err) {
      if (!(err instanceof PauseDroppedError)) throw err;
      if (err.reason === 'archived') await refuse(intent, PROJECT_ARCHIVED);
      else if (!stop.signal.aborted) throw err;
    } finally {
      holding = undefined;
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
    await dropStaleConversation();
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

  const stopForArchive = async (): Promise<void> => {
    const active = conversation;
    if (active && (await isProjectArchived(store.db, store.projectId))) {
      stopSignInWaits();
      await cancelTurn(active);
    }
    await drain();
  };

  const onEvent = (event: StoreEvent): void => {
    if (event.kind === ARCHIVE_KIND) {
      stopForArchive().catch(onError);
      return;
    }
    if (!PLANNER_INTENT_KINDS.includes(event.kind)) return;
    if (event.kind === PLANNER_NEW) {
      stopSignInWaits();
      holding?.abort();
    }
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
    stopSignInWaits();
    holding?.abort();
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
