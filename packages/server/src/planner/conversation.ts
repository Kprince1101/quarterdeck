import { getErrorMessage, loadRule, type Runtime } from '@quarterdeck/rules';
import { isAuthRequiredError } from '../acp/client/index.js';
import type { CardHuman } from '../acp/permissions/index.js';
import {
  createAgentLifecycle,
  gitWorktrees,
  type Agent,
  type AgentLifecycle,
} from '../agents/index.js';
import { publishEvent, type Store } from '../store/index.js';
import { collectReply } from './reply.js';
import {
  endTurn,
  setPlannerStatus,
  settleIntent,
  startTurn,
  type PlannerIntent,
} from './rows.js';
import {
  createPlannerSessionHost,
  type PlannerAdapters,
  type PlannerBus,
  type PlannerSession,
  type PlannerSessionHost,
} from './sessions.js';

export const PLANNER_HUMAN_EVENT = 'planner.human';
export const PLANNER_REPLY_EVENT = 'planner.reply';
export const PLANNER_FAILED_EVENT = 'planner.failed';

export interface PlannerContext {
  store: Store;
  bus: PlannerBus;
  adapters: PlannerAdapters;
  cardHuman: CardHuman;
  homeDir: string;
  openStores: () => readonly Store[];
}

export interface Conversation {
  agent: Agent;
  charter: string;
  host: PlannerSessionHost;
  lifecycle: AgentLifecycle;
  turns: number;
  reported: Set<string>;
  inTurn: boolean;
}

export interface ConversationSite {
  slug: string;
  repoPath: string;
}

export class PlannerSignInError extends Error {
  readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    super(
      `The Planner's runtime (${runtime}) is not signed in. Sign in with its own CLI, then send your message again.`,
    );
    this.name = 'PlannerSignInError';
    this.runtime = runtime;
  }
}

export const startConversation = async (
  ctx: PlannerContext,
  site: ConversationSite,
): Promise<Conversation> => {
  const rules = { homeDir: ctx.homeDir, repoDir: site.repoPath };
  const [naming, models, charter] = await Promise.all([
    loadRule('naming', rules),
    loadRule('models', rules),
    loadRule('charter', rules),
  ]);
  const host = createPlannerSessionHost({
    ...site,
    bus: ctx.bus,
    adapters: ctx.adapters,
    cardHuman: ctx.cardHuman,
  });
  const lifecycle = createAgentLifecycle({
    naming,
    sessions: host,
    worktrees: gitWorktrees,
    openStores: ctx.openStores,
  });
  const { runtime } = models.planner;
  try {
    const agent = await lifecycle.birth({
      store: ctx.store,
      role: 'planner',
      runtime,
    });
    return {
      agent,
      charter,
      host,
      lifecycle,
      turns: 0,
      reported: new Set(),
      inTurn: false,
    };
  } catch (err) {
    if (isAuthRequiredError(err)) throw new PlannerSignInError(runtime);
    throw err;
  }
};

const openSession = (conversation: Conversation): PlannerSession => {
  const session = conversation.host.current();
  if (!session) throw new Error('the Planner session is closed');
  return session;
};

const beginTurn = (
  ctx: PlannerContext,
  conversation: Conversation,
  intent: PlannerIntent,
  prompt: string,
): Promise<number> =>
  ctx.store.db.transaction(async (tx) => {
    const { agent } = conversation;
    const seq = conversation.turns + 1;
    const turnId = await startTurn(tx, agent.id, seq, prompt);
    await setPlannerStatus(tx, agent.id, 'working');
    await settleIntent(tx, intent.id, 'applied', { agentId: agent.id, seq });
    await publishEvent(tx, ctx.store.projectId, {
      kind: PLANNER_HUMAN_EVENT,
      agentId: agent.id,
      payload: { intentId: intent.id, seq, text: intent.text },
    });
    return turnId;
  });

const finishTurn = (
  ctx: PlannerContext,
  conversation: Conversation,
  turnId: number,
  outcome: { kind: string; stopReason: string | null; payload: object },
): Promise<void> =>
  ctx.store.db.transaction(async (tx) => {
    const { agent } = conversation;
    await endTurn(tx, turnId, outcome.stopReason);
    await setPlannerStatus(tx, agent.id, 'idle');
    await publishEvent(tx, ctx.store.projectId, {
      kind: outcome.kind,
      agentId: agent.id,
      payload: { seq: conversation.turns, ...outcome.payload },
    });
  });

export const runTurn = async (
  ctx: PlannerContext,
  conversation: Conversation,
  intent: PlannerIntent,
  prompt: string,
): Promise<void> => {
  const session = openSession(conversation);
  const turnId = await beginTurn(ctx, conversation, intent, prompt);
  conversation.turns += 1;
  const reply = collectReply(session);
  conversation.inTurn = true;
  const response = await session.client
    .prompt(session.sessionId, prompt)
    .catch(async (err: unknown) => {
      await finishTurn(ctx, conversation, turnId, {
        kind: PLANNER_FAILED_EVENT,
        stopReason: null,
        payload: { intentId: intent.id, error: getErrorMessage(err) },
      });
      throw err;
    })
    .finally(() => {
      conversation.inTurn = false;
      reply.stop();
    });
  await finishTurn(ctx, conversation, turnId, {
    kind: PLANNER_REPLY_EVENT,
    stopReason: response.stopReason,
    payload: { text: reply.text(), stopReason: response.stopReason },
  });
};

export const cancelTurn = async (conversation: Conversation): Promise<void> => {
  const session = conversation.host.current();
  if (!conversation.inTurn || !session) return;
  await session.client.cancel(session.sessionId);
};
