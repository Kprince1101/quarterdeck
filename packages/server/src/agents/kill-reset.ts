import { getErrorMessage } from '../lib/errors.js';
import { publishEvent, type Queryable, type Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent, type AgentStatus } from './agent.js';
import { sweepAgentProcess, type SweepOutcome } from './processes.js';
import { findAgent, firstRow, intentPayload, recordEvent } from './rows.js';
import type { SessionHost } from './sessions.js';

export const AGENT_KILLED_EVENT = 'agent.killed';
export const AGENT_RESET_EVENT = 'agent.session_reset';
export const TICKET_BLOCKED_EVENT = 'ticket.blocked';

export const FINISHED_AGENT_STATUSES: readonly AgentStatus[] = [
  'ended',
  'killed',
  'retired',
];

export const BLOCKED_ON_KILL: readonly string[] = ['assigned', 'in_progress'];

const RUNNING_STATUSES: readonly AgentStatus[] = [
  'starting',
  'working',
  'stuck',
];

export interface ControlOptions {
  intentId?: string;
}

export interface ControlHosts {
  sessions: SessionHost;
  killGraceMs?: number;
}

export class AgentFinishedError extends Error {
  readonly agentId: string;
  readonly status: AgentStatus;

  constructor(agent: Agent) {
    super(`${agent.name} is already ${agent.status}`);
    this.name = 'AgentFinishedError';
    this.agentId = agent.id;
    this.status = agent.status;
  }
}

interface BlockedTicket {
  id: string;
  previousStatus: string;
}

interface StoppedSession {
  sweep: SweepOutcome;
  failures: unknown[];
}

const blockHeldTickets = async (tx: Queryable, agent: Agent): Promise<void> => {
  const { rows } = await tx.query<BlockedTicket>(
    `with held as (
       select id, status from tickets
       where project_id = $1 and assignee_id = $2 and status = any($3::text[])
       for update
     )
     update tickets t set status = 'blocked'
     from held where t.id = held.id
     returning t.id, held.status as "previousStatus"`,
    [agent.projectId, agent.id, BLOCKED_ON_KILL],
  );
  for (const ticket of rows) {
    await publishEvent(tx, agent.projectId, {
      kind: TICKET_BLOCKED_EVENT,
      agentId: agent.id,
      ticketId: ticket.id,
      payload: {
        name: agent.name,
        previousStatus: ticket.previousStatus,
        reason: 'killed',
      },
    });
  }
};

const finishedError = async (
  tx: Queryable,
  projectId: string,
  agentId: string,
): Promise<AgentFinishedError> => {
  const { rows } = await tx.query<Agent>(
    `select ${AGENT_COLUMNS} from agents where id = $1 and project_id = $2`,
    [agentId, projectId],
  );
  return new AgentFinishedError(firstRow(rows, agentId));
};

const markKilled = (store: Store, agentId: string): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents
       set status = 'killed', ended_at = coalesce(ended_at, now())
       where id = $1 and project_id = $2 and status <> all($3::text[])
       returning ${AGENT_COLUMNS}`,
      [agentId, store.projectId, FINISHED_AGENT_STATUSES],
    );
    const [killed] = rows;
    if (!killed) throw await finishedError(tx, store.projectId, agentId);
    await blockHeldTickets(tx, killed);
    return killed;
  });

const closeQuietly = async (
  sessions: SessionHost,
  sessionId: string | null,
): Promise<unknown[]> => {
  if (sessionId === null) return [];
  try {
    await sessions.close(sessionId);
    return [];
  } catch (err) {
    return [err];
  }
};

const stopSession = async (
  store: Store,
  hosts: ControlHosts,
  agent: Agent,
  reason: 'kill' | 'reset',
): Promise<StoppedSession> => {
  const failures = await closeQuietly(hosts.sessions, agent.sessionId);
  const sweep = await sweepAgentProcess(
    store,
    agent,
    reason,
    hosts.killGraceMs,
  );
  return { sweep, failures };
};

const closeErrorPayload = (failures: unknown[]): Record<string, string> => {
  const [failure] = failures;
  if (failures.length === 0) return {};
  return { closeError: getErrorMessage(failure) };
};

export const killAgent = async (
  store: Store,
  hosts: ControlHosts,
  agentId: string,
  options: ControlOptions = {},
): Promise<Agent> => {
  const killed = await markKilled(store, agentId);
  const { sweep, failures } = await stopSession(store, hosts, killed, 'kill');
  await recordEvent(store.db, killed, AGENT_KILLED_EVENT, {
    name: killed.name,
    sessionId: killed.sessionId,
    sweep,
    ...closeErrorPayload(failures),
    ...intentPayload(options.intentId),
  });
  return killed;
};

export const resetAgent = async (
  store: Store,
  hosts: ControlHosts,
  agentId: string,
  options: ControlOptions = {},
): Promise<Agent> => {
  const agent = await findAgent(store, agentId);
  if (agent.status === 'retired') throw new AgentFinishedError(agent);
  const { sweep, failures } = await stopSession(store, hosts, agent, 'reset');
  if (failures.length > 0) throw failures[0];
  return store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents
       set session_id = null,
           status = case when status = any($2::text[]) then 'idle'
                    else status end
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id, RUNNING_STATUSES],
    );
    const reset = firstRow(rows, agent.id);
    await recordEvent(tx, reset, AGENT_RESET_EVENT, {
      name: agent.name,
      sessionId: agent.sessionId,
      sweep,
      ...intentPayload(options.intentId),
    });
    return reset;
  });
};
