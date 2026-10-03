import { FINISHED_AGENT_STATUSES } from '../../agents/index.js';
import type {
  CrewIntentName,
  IntentReply,
  IntentStatus,
} from '../../intents/index.js';
import type {
  ApiContext,
  ApiVoyages,
  DeskReply,
  IntentHandler,
  IntentHandlers,
  ProjectCheck,
} from '../context.js';
import { HttpError, conflict } from '../http-error.js';
import { findRow, queueInProject } from '../record.js';
import { PAUSE_HANDLERS } from './pause.js';
import { PLANNER_HANDLERS } from './planner.js';

type AgentIntentName = Extract<CrewIntentName, `agent.${string}`>;
type VoyageIntentName = Extract<CrewIntentName, `voyage.${string}`>;

const FINISHED_AGENTS: ReadonlySet<string> = new Set(FINISHED_AGENT_STATUSES);
const RETIRED_AGENTS: ReadonlySet<string> = new Set(['retired']);

const requireAgentNotIn =
  (refused: ReadonlySet<string>) =>
  (agentId: string): ProjectCheck =>
  async (tx, projectId) => {
    const agent = await findRow<{ status: string }>(
      tx,
      'select status from agents where id = $1 and project_id = $2',
      [agentId, projectId],
      `agent ${agentId} not found`,
    );
    if (refused.has(agent.status)) {
      throw conflict(`agent ${agentId} is already ${agent.status}`);
    }
  };

const requireLiveAgent = requireAgentNotIn(FINISHED_AGENTS);

const requireUnretiredAgent = requireAgentNotIn(RETIRED_AGENTS);

export const NO_VOYAGES = 'voyages run under quarterdeck up';

const voyagesOf = (ctx: ApiContext): ApiVoyages => {
  if (ctx.voyages === undefined) throw new HttpError(503, NO_VOYAGES);
  return ctx.voyages;
};

const replyOf = <N extends VoyageIntentName>(
  name: N,
  status: IntentStatus,
  reply: DeskReply,
): IntentReply => {
  if (!reply.ok) throw conflict(reply.error);
  return { intent: name, status, id: null, result: reply.result };
};

const startVoyage: IntentHandler<'voyage.start'> = async (ctx, input, name) =>
  replyOf(name, 'applied', await voyagesOf(ctx).start(input.goal));

const endVoyage: IntentHandler<'voyage.end'> = async (ctx, input, name) =>
  replyOf(name, 'pending', await voyagesOf(ctx).end(input.voyage));

const killVoyage: IntentHandler<'voyage.kill'> = async (ctx, input, name) =>
  replyOf(name, 'applied', await voyagesOf(ctx).kill(input.voyage));

type QueuedIntentName = Exclude<
  CrewIntentName,
  'pause.all' | 'planner.new' | 'planner.move' | VoyageIntentName
>;

const queue: IntentHandler<QueuedIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input);

const queueForAgent: IntentHandler<AgentIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input, requireLiveAgent(input.agentId));

const queueForUnretiredAgent: IntentHandler<AgentIntentName> = (
  ctx,
  input,
  name,
) => queueInProject(ctx, name, input, requireUnretiredAgent(input.agentId));

export const CREW_HANDLERS: IntentHandlers<CrewIntentName> = {
  'voyage.start': startVoyage,
  'voyage.end': endVoyage,
  'voyage.kill': killVoyage,
  'project.kill': queue,
  ...PAUSE_HANDLERS,
  'agent.end': queueForAgent,
  'agent.kill': queueForAgent,
  'agent.retire': queueForUnretiredAgent,
  'agent.reset': queueForUnretiredAgent,
  'agent.message': queueForAgent,
  ...PLANNER_HANDLERS,
};
