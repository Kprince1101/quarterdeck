import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, AgentNotFoundError, type Agent } from './agent.js';

export type Queryable = Pick<PGlite | Transaction, 'query'>;

export const firstRow = (rows: Agent[], agentId: string): Agent => {
  const [agent] = rows;
  if (!agent) throw new AgentNotFoundError(agentId);
  return agent;
};

export const recordEvent = async (
  db: Queryable,
  agent: Agent,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await db.query(
    `insert into events (project_id, agent_id, kind, payload)
     values ($1, $2, $3, $4)`,
    [agent.projectId, agent.id, kind, JSON.stringify(payload)],
  );
};

export const findAgent = async (
  store: Store,
  agentId: string,
): Promise<Agent> => {
  const { rows } = await store.db.query<Agent>(
    `select ${AGENT_COLUMNS} from agents
     where id = $1 and project_id = $2`,
    [agentId, store.projectId],
  );
  return firstRow(rows, agentId);
};

export const markRetired = (
  store: Store,
  agent: Agent,
  kind: string,
  payload: Record<string, unknown>,
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents
       set status = 'retired', session_id = null, worktree_path = null,
           ended_at = coalesce(ended_at, now())
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id],
    );
    const retired = firstRow(rows, agent.id);
    await recordEvent(tx, retired, kind, { name: agent.name, ...payload });
    return retired;
  });
