import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent, type AgentStatus } from './agent.js';
import { sweepAgentProcess, type SweepOutcome } from './processes.js';
import { findAgent, firstRow, intentPayload, recordEvent } from './rows.js';
import type { SessionHost } from './sessions.js';

export const AGENT_KILLED_EVENT = 'agent.killed';
export const AGENT_RESET_EVENT = 'agent.session_reset';

export const FINISHED_AGENT_STATUSES: readonly AgentStatus[] = [
  'ended',
  'killed',
  'retired',
];

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

const markKilled = async (store: Store, agentId: string): Promise<Agent> => {
  const { rows } = await store.db.query<Agent>(
    `update agents
     set status = 'killed', ended_at = coalesce(ended_at, now())
     where id = $1 and project_id = $2 and status <> all($3::text[])
     returning ${AGENT_COLUMNS}`,
    [agentId, store.projectId, FINISHED_AGENT_STATUSES],
  );
  const [killed] = rows;
  if (killed) return killed;
  throw new AgentFinishedError(await findAgent(store, agentId));
};

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
): Promise<SweepOutcome> => {
  const failures = await closeQuietly(hosts.sessions, agent.sessionId);
  const sweep = await sweepAgentProcess(
    store,
    agent,
    reason,
    hosts.killGraceMs,
  );
  if (failures.length > 0) throw failures[0];
  return sweep;
};

export const killAgent = async (
  store: Store,
  hosts: ControlHosts,
  agentId: string,
  options: ControlOptions = {},
): Promise<Agent> => {
  const killed = await markKilled(store, agentId);
  const sweep = await stopSession(store, hosts, killed, 'kill');
  await recordEvent(store.db, killed, AGENT_KILLED_EVENT, {
    name: killed.name,
    sessionId: killed.sessionId,
    sweep,
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
  const sweep = await stopSession(store, hosts, agent, 'reset');
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
