import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent } from './agent.js';
import { assertDiscardApproved } from './discard.js';
import { findAgent, firstRow, markRetired, recordEvent } from './rows.js';
import type { SessionHost } from './sessions.js';
import type { WorktreeHost } from './worktrees.js';

export interface RetireOptions {
  discardCardId?: string;
}

export interface RetireHosts {
  sessions: SessionHost;
  worktrees: WorktreeHost;
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
    await recordEvent(tx, ended, 'agent.session_closed', {
      name: agent.name,
      sessionId,
    });
    return ended;
  });

const detachWorktree = (
  store: Store,
  agent: Agent,
  worktreePath: string,
  discarded: boolean,
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents set worktree_path = null
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id],
    );
    const detached = firstRow(rows, agent.id);
    await recordEvent(tx, detached, 'agent.worktree_removed', {
      name: agent.name,
      worktreePath,
      discarded,
    });
    return detached;
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
  worktrees: WorktreeHost,
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
  const cleared = await removeWorktree(store, hosts.worktrees, closed, options);
  return markRetired(store, cleared, 'agent.retired', {});
};
