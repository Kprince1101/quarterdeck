import {
  forgeTerms,
  forgeWording,
  getErrorMessage,
  loadRule,
  type ForgeTerms,
} from '@quarterdeck/rules';
import type { CardHuman } from '../acp/permissions/index.js';
import {
  createAgentLifecycle,
  gitWorktrees,
  type Agent,
  type AgentLifecycle,
} from '../agents/index.js';
import type { StopReason } from '@agentclientprotocol/sdk';
import { MAX_REPROMPTS } from '../driver/turns.js';
import { repoForge } from '../gate/index.js';
import { redactValue } from '../lib/redact.js';
import { withSignIn } from '../signin/index.js';
import {
  publishEvent,
  type Queryable,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import { refusalsText, repromptText } from './brief.js';
import { collectReply } from './reply.js';
import {
  endTurn,
  refusedProposals,
  setPlannerStatus,
  settleIntent,
  startTurn,
  type PlannerIntent,
} from './rows.js';
import {
  createPlannerSessionHost,
  plannerSignInGate,
  type PlannerAdapters,
  type PlannerBus,
  type PlannerSession,
  type PlannerSessionHost,
} from './sessions.js';

export const PLANNER_HUMAN_EVENT = 'planner.human';
export const PLANNER_REPLY_EVENT = 'planner.reply';
export const PLANNER_FAILED_EVENT = 'planner.failed';
export const PLANNER_MISSED_EVENT = 'planner.missed';

const STOPPING: ReadonlySet<StopReason> = new Set(['cancelled', 'refusal']);

export interface PlannerContext {
  store: Store;
  bus: PlannerBus;
  adapters: PlannerAdapters;
  cardHumanFor: (agent: Agent) => CardHuman;
  homeDir: string;
  openStores: () => readonly Store[];
  signInSignal: () => AbortSignal;
}

export interface Conversation {
  agent: Agent;
  charter: string;
  terms: ForgeTerms;
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

export const startConversation = async (
  ctx: PlannerContext,
  site: ConversationSite,
): Promise<Conversation> => {
  const rules = { homeDir: ctx.homeDir, repoDir: site.repoPath };
  const [naming, models, charter, lifecycleRule, env, forge] =
    await Promise.all([
      loadRule('naming', rules),
      loadRule('models', rules),
      loadRule('charter', rules),
      loadRule('lifecycle', rules),
      loadRule('env', rules),
      repoForge(site.repoPath, { homeDir: ctx.homeDir }),
    ]);
  const terms = forgeTerms(forge);
  const host = createPlannerSessionHost({
    ...site,
    passEnv: env.pass,
    store: ctx.store,
    bus: ctx.bus,
    adapters: ctx.adapters,
    cardHumanFor: ctx.cardHumanFor,
    signInSignal: ctx.signInSignal,
    homeDir: ctx.homeDir,
  });
  const lifecycle = createAgentLifecycle({
    naming,
    sessions: host,
    worktrees: gitWorktrees,
    openStores: ctx.openStores,
    budget: () => Promise.resolve(lifecycleRule.budget.window),
  });
  const agent = await lifecycle.birth({
    store: ctx.store,
    role: 'planner',
    runtime: models.planner.runtime,
  });
  return {
    agent,
    charter: forgeWording(charter, terms),
    terms,
    host,
    lifecycle,
    turns: 0,
    reported: new Set(),
    inTurn: false,
  };
};

const openSession = (conversation: Conversation): PlannerSession => {
  const session = conversation.host.current();
  if (!session) throw new Error('the Planner session is closed');
  return session;
};

interface StartedTurn {
  turnId: number;
  since: number;
}

const beginTurn = (
  ctx: PlannerContext,
  conversation: Conversation,
  prompt: string,
  opening: (tx: Queryable, seq: number) => Promise<StoreEvent>,
): Promise<StartedTurn> =>
  ctx.store.db.transaction(async (tx) => {
    const { agent } = conversation;
    const seq = conversation.turns + 1;
    const turnId = await startTurn(tx, agent.id, seq, prompt);
    await setPlannerStatus(tx, agent.id, 'working');
    const opened = await opening(tx, seq);
    return { turnId, since: opened.id };
  });

const humanOpening =
  (ctx: PlannerContext, conversation: Conversation, intent: PlannerIntent) =>
  async (tx: Queryable, seq: number): Promise<StoreEvent> => {
    const { agent } = conversation;
    await settleIntent(tx, intent.id, 'applied', { agentId: agent.id, seq });
    return publishEvent(tx, ctx.store.projectId, {
      kind: PLANNER_HUMAN_EVENT,
      agentId: agent.id,
      payload: { intentId: intent.id, seq, text: intent.text },
    });
  };

const recordMiss = (
  ctx: PlannerContext,
  conversation: Conversation,
  db: Queryable,
  miss: { error: string; reprompt: boolean },
): Promise<StoreEvent> =>
  publishEvent(db, ctx.store.projectId, {
    kind: PLANNER_MISSED_EVENT,
    agentId: conversation.agent.id,
    payload: redactValue({ seq: conversation.turns, ...miss }),
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
      payload: redactValue({ seq: conversation.turns, ...outcome.payload }),
    });
  });

const sendPrompt = async (
  ctx: PlannerContext,
  conversation: Conversation,
  intent: PlannerIntent,
  turn: { turnId: number; prompt: string },
): Promise<StopReason> => {
  const { turnId, prompt } = turn;
  const session = openSession(conversation);
  const reply = collectReply(session);
  conversation.inTurn = true;
  const gate = plannerSignInGate(
    ctx.store,
    conversation.agent,
    ctx.signInSignal(),
    () => session.client.agent.authMethods,
  );
  const response = await withSignIn(gate, 'session/prompt', () =>
    session.client.prompt(session.sessionId, prompt),
  )
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
  return response.stopReason;
};

const unfixedRefusals = async (
  ctx: PlannerContext,
  conversation: Conversation,
  since: number,
): Promise<string | null> => {
  const refused = await refusedProposals(
    ctx.store.db,
    ctx.store.projectId,
    conversation.agent.id,
    since,
  );
  if (refused.length === 0) return null;
  return refusalsText(refused);
};

export const runTurn = async (
  ctx: PlannerContext,
  conversation: Conversation,
  intent: PlannerIntent,
  prompt: string,
): Promise<void> => {
  openSession(conversation);
  const ending = ctx.signInSignal();
  const { turnId, since } = await beginTurn(
    ctx,
    conversation,
    prompt,
    humanOpening(ctx, conversation, intent),
  );
  conversation.turns += 1;
  let turn = { turnId, prompt };
  for (let reprompts = 0; ; reprompts += 1) {
    const stopReason = await sendPrompt(ctx, conversation, intent, turn);
    if (STOPPING.has(stopReason) || ending.aborted) return;
    const error = await unfixedRefusals(ctx, conversation, since);
    if (error === null) return;
    const miss = { error, reprompt: reprompts < MAX_REPROMPTS };
    if (!miss.reprompt) {
      await recordMiss(ctx, conversation, ctx.store.db, miss);
      return;
    }
    const text = repromptText(error, conversation.terms);
    const next = await beginTurn(ctx, conversation, text, (tx) =>
      recordMiss(ctx, conversation, tx, miss),
    );
    conversation.turns += 1;
    turn = { turnId: next.turnId, prompt: text };
  }
};

export const cancelTurn = async (conversation: Conversation): Promise<void> => {
  const session = conversation.host.current();
  if (!conversation.inTurn || !session) return;
  await session.client.cancel(session.sessionId);
};
