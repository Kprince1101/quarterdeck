import type { CrewIntentName } from '../../intents/index.js';
import type {
  IntentHandler,
  IntentHandlers,
  ProjectCheck,
} from '../context.js';
import { conflict } from '../http-error.js';
import { findRow, queueInProject } from '../record.js';

type AgentIntentName = Extract<CrewIntentName, `agent.${string}`>;

const FINISHED_AGENT_STATUSES = new Set(['ended', 'killed', 'retired']);
const RETIRED_AGENT_STATUSES = new Set(['retired']);

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

const requireLiveAgent = requireAgentNotIn(FINISHED_AGENT_STATUSES);

const requireUnretiredAgent = requireAgentNotIn(RETIRED_AGENT_STATUSES);

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

const queue: IntentHandler<CrewIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input);

const queueForAgent: IntentHandler<AgentIntentName> = (ctx, input, name) =>
  queueInProject(ctx, name, input, requireLiveAgent(input.agentId));

export const CREW_HANDLERS: IntentHandlers<CrewIntentName> = {
  'round.start': queue,
  'round.end': (ctx, input, name) =>
    queueInProject(ctx, name, input, requireOpenRound(input.roundId)),
  'pause.set': queue,
  'agent.pause': queueForAgent,
  'agent.resume': queueForAgent,
  'agent.end': queueForAgent,
  'agent.kill': queueForAgent,
  'agent.retire': (ctx, input, name) =>
    queueInProject(ctx, name, input, requireUnretiredAgent(input.agentId)),
  'agent.message': queueForAgent,
  'planner.message': queue,
};
