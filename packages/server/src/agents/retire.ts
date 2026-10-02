import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent } from './agent.js';
import { assertDiscardApproved } from './discard.js';
import { sweepAgentProcess } from './processes.js';
import {
  findAgent,
  firstRow,
  intentPayload,
  markRetired,
  recordEvent,
} from './rows.js';
import type { SessionHost } from './sessions.js';
import { WORKPLACE_EVENTS, detachWorktree } from './workplace.js';
import type { WorktreeHost } from './worktrees.js';

export const AGENT_RETIRED_EVENT = 'agent.retired';

export interface RetireOptions {
  discardCardId?: string;
  intentId?: string;
}

export interface RetireHosts {
  sessions: SessionHost;
  worktrees: Pick<WorktreeHost, 'remove'>;
  killGraceMs?: number;
}

const detachSession = (
  store: Store,
  agent: Agent,
  sessionId: string,
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents
       set session_id = null, ended_at = coalesce(ended_at, now()),
           status = case status when 'killed' then 'killed' else 'ended' end
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id],
    );
    const ended = firstRow(rows, agent.id);
    await recordEvent(tx, ended, WORKPLACE_EVENTS.sessionClosed, {
      name: agent.name,
      sessionId,
    });
    return ended;
  });

const closeSession = async (
  store: Store,
  sessions: SessionHost,
  agent: Agent,
): Promise<Agent> => {
  if (agent.sessionId === null) return agent;
  await sessions.close(agent.sessionId);
  return detachSession(store, agent, agent.sessionId);
};

const removeWorktree = async (
  store: Store,
  worktrees: RetireHosts['worktrees'],
  agent: Agent,
  options: RetireOptions,
): Promise<Agent> => {
  if (agent.worktreePath === null) return agent;
  const cardId = options.discardCardId;
  if (cardId !== undefined) await assertDiscardApproved(store, agent, cardId);
  const force = cardId !== undefined;
  await worktrees.remove(agent.worktreePath, { force });
  return detachWorktree(store, agent, agent.worktreePath, force);
};

export const retireAgent = async (
  store: Store,
  hosts: RetireHosts,
  agentId: string,
  options: RetireOptions = {},
): Promise<Agent> => {
  const agent = await findAgent(store, agentId);
  if (agent.status === 'retired') return agent;
  const closed = await closeSession(store, hosts.sessions, agent);
  await sweepAgentProcess(store, closed, 'retire', hosts.killGraceMs);
  const cleared = await removeWorktree(store, hosts.worktrees, closed, options);
  return markRetired(
    store,
    cleared,
    AGENT_RETIRED_EVENT,
    intentPayload(options.intentId),
  );
};
