import { FINISHED_AGENT_STATUSES } from '../../agents/index.js';
import type { CrewIntentName } from '../../intents/index.js';
import type {
  IntentHandler,
  IntentHandlers,
  ProjectCheck,
} from '../context.js';
import { conflict } from '../http-error.js';
import { findRow, queueInProject } from '../record.js';
import { PAUSE_HANDLERS } from './pause.js';

type AgentIntentName = Extract<CrewIntentName, `agent.${string}`>;
type RoundIntentName = Extract<CrewIntentName, 'round.end' | 'round.kill'>;

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

const requireOpenRound =
  (roundId: string): ProjectCheck =>
  async (tx, projectId) => {
    const round = await findRow<{ status: string }>(
      tx,
      'select status from rounds where id = $1 and project_id = $2',
      [roundId, projectId],
      `round ${roundId} not found`,
    );
    if (round.status === 'ended') {
      throw conflict(`round ${roundId} has already ended`);
    }
  };

type QueuedIntentName = Exclude<CrewIntentName, 'pause.all'>;

const queue: IntentHandler<QueuedIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input);

const queueForRound: IntentHandler<RoundIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input, requireOpenRound(input.roundId));

const queueForAgent: IntentHandler<AgentIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input, requireLiveAgent(input.agentId));

const queueForUnretiredAgent: IntentHandler<AgentIntentName> = (
  ctx,
  input,
  name,
) => queueInProject(ctx, name, input, requireUnretiredAgent(input.agentId));

export const CREW_HANDLERS: IntentHandlers<CrewIntentName> = {
  'round.start': queue,
  'round.end': queueForRound,
  'round.kill': queueForRound,
  ...PAUSE_HANDLERS,
  'agent.end': queueForAgent,
  'agent.kill': queueForAgent,
  'agent.retire': queueForUnretiredAgent,
  'agent.reset': queueForUnretiredAgent,
  'agent.message': queueForAgent,
  'planner.message': queue,
  'planner.new': queue,
};
