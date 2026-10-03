import { getErrorMessage, type Runtime } from '@quarterdeck/rules';
import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent, type AgentRole } from './agent.js';
import type { RetireHosts } from './retire.js';
import { findAgent, firstRow, markRetired, recordEvent } from './rows.js';
import { detachWorktree } from './workplace.js';

export interface BirthRequest {
  store: Store;
  role: AgentRole;
  runtime: Runtime;
  voyageId?: string;
  ticketId?: string;
  prepare?: (agent: Agent) => Promise<Agent>;
}

const unprepared = (agent: Agent): Promise<Agent> => Promise.resolve(agent);

export const insertAgent = (
  request: BirthRequest,
  name: string,
): Promise<Agent> =>
  request.store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `insert into agents (project_id, voyage_id, name, role, runtime)
       values ($1, $2, $3, $4, $5)
       returning ${AGENT_COLUMNS}`,
      [
        request.store.projectId,
        request.voyageId ?? null,
        name,
        request.role,
        request.runtime,
      ],
    );
    const agent = firstRow(rows, name);
    await recordEvent(tx, agent, 'agent.born', {
      name,
      role: agent.role,
      runtime: agent.runtime,
    });
    return agent;
  });

export const BIRTH_CANCELLED_EVENT = 'agent.birth_cancelled';

export class BirthCancelledError extends Error {
  readonly agentId: string;
  readonly reason: string;

  constructor(agent: Agent, reason: string) {
    super(`${agent.name} was not born: ${reason} while starting`);
    this.name = 'BirthCancelledError';
    this.agentId = agent.id;
    this.reason = reason;
  }
}

const UNBORN_STATUSES = `('starting', 'paused')`;

const PROJECT_OPEN = `exists (
  select 1 from projects p
  where p.id = agents.project_id and p.archived_at is null
)`;

const attachSession = async (
  store: Store,
  agent: Agent,
  sessionId: string,
): Promise<Agent | undefined> => {
  const { rows } = await store.db.query<Agent>(
    `update agents
     set session_id = $2,
         status = case when status = 'paused' then status else 'idle' end
     where id = $1 and status in ${UNBORN_STATUSES} and ${PROJECT_OPEN}
     returning ${AGENT_COLUMNS}`,
    [agent.id, sessionId],
  );
  return rows[0];
};

const cancelReason = async (
  store: Store,
  agentId: string,
): Promise<string | undefined> => {
  const { rows } = await store.db.query<{
    status: string;
    archived: boolean;
  }>(
    `select a.status, p.archived_at is not null as archived
     from agents a join projects p on p.id = a.project_id
     where a.id = $1`,
    [agentId],
  );
  const [row] = rows;
  if (!row) return 'deleted';
  if (row.status !== 'starting' && row.status !== 'paused') return row.status;
  if (row.archived) return 'archived';
  return undefined;
};

const cancelBirth = async (
  store: Store,
  hosts: RetireHosts,
  agent: Agent,
  sessionId: string | undefined,
  reason: string,
): Promise<never> => {
  if (sessionId !== undefined) await hosts.sessions.close(sessionId);
  let current = await findAgent(store, agent.id);
  if (current.worktreePath !== null) {
    await hosts.worktrees.remove(current.worktreePath);
    current = await detachWorktree(store, current, current.worktreePath, false);
  }
  const payload = { name: agent.name, reason, sessionId: sessionId ?? null };
  if (current.status === 'retired') {
    await recordEvent(store.db, current, BIRTH_CANCELLED_EVENT, payload);
  } else {
    await markRetired(store, current, BIRTH_CANCELLED_EVENT, payload);
  }
  throw new BirthCancelledError(agent, reason);
};

const retireUnborn = async (
  store: Store,
  agent: Agent,
  openError: unknown,
): Promise<void> => {
  try {
    await markRetired(store, agent, 'agent.birth_failed', {
      error: getErrorMessage(openError),
    });
  } catch (retireError) {
    throw new AggregateError(
      [openError, retireError],
      `${agent.name} could not open a session and could not be retired`,
    );
  }
};

export const openSession = async (
  store: Store,
  hosts: RetireHosts,
  agent: Agent,
  prepare: (agent: Agent) => Promise<Agent> = unprepared,
): Promise<Agent> => {
  let prepared: Agent;
  let sessionId: string | undefined;
  try {
    prepared = await prepare(agent);
    if ((await cancelReason(store, agent.id)) === undefined) {
      sessionId = await hosts.sessions.open(prepared);
      const attached = await attachSession(store, prepared, sessionId);
      if (attached) return attached;
    }
  } catch (err) {
    await retireUnborn(store, agent, err);
    throw err;
  }
  const reason = (await cancelReason(store, agent.id)) ?? 'archived';
  return cancelBirth(store, hosts, prepared, sessionId, reason);
};
