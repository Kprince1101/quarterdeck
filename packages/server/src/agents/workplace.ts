import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent } from './agent.js';
import { firstRow, recordEvent } from './rows.js';

export const WORKPLACE_EVENTS = {
  worktreeAdded: 'agent.worktree_added',
  worktreeRemoved: 'agent.worktree_removed',
  sessionOpened: 'agent.session_opened',
  sessionClosed: 'agent.session_closed',
} as const;

export const attachWorktree = (
  store: Store,
  agent: Agent,
  worktreePath: string,
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents set worktree_path = $2
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id, worktreePath],
    );
    const attached = firstRow(rows, agent.id);
    await recordEvent(tx, attached, WORKPLACE_EVENTS.worktreeAdded, {
      name: agent.name,
      worktreePath,
    });
    return attached;
  });

export const detachWorktree = (
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
    await recordEvent(tx, detached, WORKPLACE_EVENTS.worktreeRemoved, {
      name: agent.name,
      worktreePath,
      discarded,
    });
    return detached;
  });

const sessionEvent = (sessionId: string | null) => {
  if (sessionId === null) return WORKPLACE_EVENTS.sessionClosed;
  return WORKPLACE_EVENTS.sessionOpened;
};

export const replaceSession = (
  store: Store,
  agent: Agent,
  sessionId: string | null,
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents set session_id = $2
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id, sessionId],
    );
    const replaced = firstRow(rows, agent.id);
    await recordEvent(tx, replaced, sessionEvent(sessionId), {
      name: agent.name,
      sessionId: sessionId ?? agent.sessionId,
    });
    return replaced;
  });
