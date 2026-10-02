import { PROPOSED_EVENT } from '../bus/tools/propose.js';
import type { Queryable } from '../store/index.js';
import type { ProposalDecision } from './brief.js';

export const PLANNER_MESSAGE = 'planner.message';
export const PLANNER_NEW = 'planner.new';

export const PLANNER_INTENT_KINDS: readonly string[] = [
  PLANNER_MESSAGE,
  PLANNER_NEW,
];

export interface PlannerIntent {
  id: string;
  kind: string;
  text: string | null;
}

export interface ProjectSite {
  slug: string;
  repoPath: string | null;
}

export type SettledStatus = 'applied' | 'rejected';

export const projectSite = async (
  db: Queryable,
  projectId: string,
): Promise<ProjectSite> => {
  const { rows } = await db.query<ProjectSite>(
    `select slug, repo_path as "repoPath" from projects where id = $1`,
    [projectId],
  );
  const [site] = rows;
  if (!site) throw new Error(`project ${projectId} is gone`);
  return site;
};

export const pendingPlannerIntents = async (
  db: Queryable,
  projectId: string,
): Promise<PlannerIntent[]> => {
  const { rows } = await db.query<PlannerIntent>(
    `select id, kind, input ->> 'text' as text from intents
     where project_id = $1 and status = 'pending' and kind = any($2::text[])
     order by created_at, id`,
    [projectId, PLANNER_INTENT_KINDS],
  );
  return rows;
};

export const settleIntents = async (
  db: Queryable,
  intentIds: readonly string[],
  status: SettledStatus,
  result: Record<string, unknown>,
): Promise<number> => {
  if (intentIds.length === 0) return 0;
  const { rows } = await db.query<{ id: string }>(
    `update intents set status = $2, result = $3::jsonb, settled_at = now()
     where id = any($1::uuid[]) and status = 'pending'
     returning id`,
    [intentIds, status, JSON.stringify(result)],
  );
  return rows.length;
};

export const settleIntent = async (
  db: Queryable,
  intentId: string,
  status: SettledStatus,
  result: Record<string, unknown>,
): Promise<boolean> =>
  (await settleIntents(db, [intentId], status, result)) > 0;

export const livePlannerIds = async (
  db: Queryable,
  projectId: string,
): Promise<string[]> => {
  const { rows } = await db.query<{ id: string }>(
    `select id from agents
     where project_id = $1 and role = 'planner' and status <> 'retired'
     order by created_at`,
    [projectId],
  );
  return rows.map((row) => row.id);
};

export const setPlannerStatus = async (
  db: Queryable,
  agentId: string,
  status: 'idle' | 'working',
): Promise<void> => {
  await db.query(
    `update agents set status = $2
     where id = $1 and status in ('idle', 'working')`,
    [agentId, status],
  );
};

export const decidedProposals = async (
  db: Queryable,
  projectId: string,
  agentId: string,
): Promise<ProposalDecision[]> => {
  const { rows } = await db.query<ProposalDecision>(
    `select t.id as "ticketId", t.title, t.status
     from events e join tickets t on t.id = e.ticket_id
     where e.project_id = $1 and e.agent_id = $2 and e.kind = $3
       and t.status <> 'proposed'
     order by e.id`,
    [projectId, agentId, PROPOSED_EVENT],
  );
  return rows;
};

export const startTurn = async (
  db: Queryable,
  agentId: string,
  seq: number,
  prompt: string,
): Promise<number> => {
  const { rows } = await db.query<{ id: number }>(
    `insert into turns (agent_id, seq, prompt) values ($1, $2, $3)
     returning id`,
    [agentId, seq, prompt],
  );
  const [turn] = rows;
  if (!turn) throw new Error(`turn ${seq} was not recorded`);
  return turn.id;
};

export const endTurn = async (
  db: Queryable,
  turnId: number,
  stopReason: string | null,
): Promise<void> => {
  await db.query(
    `update turns set stop_reason = $2, ended_at = now() where id = $1`,
    [turnId, stopReason],
  );
};
