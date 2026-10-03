import type { Queryable } from '../store/index.js';

export const AGENT_KILL = 'agent.kill';
export const AGENT_RETIRE = 'agent.retire';
export const AGENT_RESET = 'agent.reset';
export const PROJECT_KILL = 'project.kill';

export type LifecycleIntentKind =
  | typeof AGENT_KILL
  | typeof AGENT_RETIRE
  | typeof AGENT_RESET
  | typeof PROJECT_KILL;

export const LIFECYCLE_INTENT_KINDS: readonly string[] = [
  AGENT_KILL,
  AGENT_RETIRE,
  AGENT_RESET,
  PROJECT_KILL,
];

export interface LifecycleIntent {
  id: string;
  kind: LifecycleIntentKind;
  agentId: string;
  discardCardId: string | null;
}

export const liveBuilderIds = async (
  db: Queryable,
  projectId: string,
): Promise<string[]> => {
  const { rows } = await db.query<{ id: string }>(
    `select id from agents
     where project_id = $1 and role = 'builder'
       and status not in ('ended', 'killed', 'retired')
     order by created_at, id`,
    [projectId],
  );
  return rows.map((row) => row.id);
};

export interface DiscardCard {
  status: string;
  answer: string | null;
}

export const pendingLifecycleIntents = async (
  db: Queryable,
  projectId: string,
): Promise<LifecycleIntent[]> => {
  const { rows } = await db.query<LifecycleIntent>(
    `select id, kind, coalesce(input ->> 'agentId', '') as "agentId",
       result ->> 'discardCardId' as "discardCardId"
     from intents
     where project_id = $1 and status = 'pending' and kind = any($2::text[])
     order by created_at, seq`,
    [projectId, LIFECYCLE_INTENT_KINDS],
  );
  return rows;
};

export const awaitDiscardCard = async (
  db: Queryable,
  intentId: string,
  discardCardId: string,
): Promise<void> => {
  await db.query(
    `update intents set result = $2::jsonb
     where id = $1 and status = 'pending'`,
    [intentId, JSON.stringify({ discardCardId })],
  );
};

export const readDiscardCard = async (
  db: Queryable,
  projectId: string,
  cardId: string,
): Promise<DiscardCard | undefined> => {
  const { rows } = await db.query<DiscardCard>(
    'select status, answer from cards where id = $1 and project_id = $2',
    [cardId, projectId],
  );
  return rows[0];
};
