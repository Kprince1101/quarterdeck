import { z } from 'zod';
import type { Queryable } from '../store/index.js';
import { BusToolError } from './tool.js';

export const REVIEW_NOTES_MAX = 8000;
export const PR_URL_MAX = 2000;

export const notesSchema = z.string().trim().min(1).max(REVIEW_NOTES_MAX);

export const ticketIdSchema = z.uuid();

const GONE_STATUSES: readonly string[] = ['ended', 'killed', 'retired'];

export interface ReviewTicket {
  id: string;
  status: string;
  assigneeId: string | null;
  prUrl: string | null;
  headSha: string | null;
}

export interface ReviewAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

export const lockTicket = async (
  tx: Queryable,
  projectId: string,
  ticketId: string,
): Promise<ReviewTicket> => {
  const {
    rows: [ticket],
  } = await tx.query<ReviewTicket>(
    `select id, status, assignee_id as "assigneeId", pr_url as "prUrl",
       head_sha as "headSha"
     from tickets where id = $1 and project_id = $2 for update`,
    [ticketId, projectId],
  );
  if (ticket === undefined)
    throw new BusToolError(`no ticket ${ticketId} in this project`);
  return ticket;
};

export const findCaller = async (
  tx: Queryable,
  projectId: string,
  agentId: string,
): Promise<ReviewAgent> => {
  const {
    rows: [agent],
  } = await tx.query<ReviewAgent>(
    `select id, name, role, status from agents
     where id = $1 and project_id = $2`,
    [agentId, projectId],
  );
  if (agent === undefined)
    throw new BusToolError(`no agent ${agentId} in this project`);
  return agent;
};

export const isGone = (agent: ReviewAgent): boolean =>
  GONE_STATUSES.includes(agent.status);

export const liveReviewer = async (
  tx: Queryable,
  projectId: string,
): Promise<ReviewAgent | undefined> => {
  const { rows } = await tx.query<ReviewAgent>(
    `select id, name, role, status from agents
     where project_id = $1 and role = 'reviewer'
       and status <> all($2::text[])
     order by created_at, id
     limit 1`,
    [projectId, GONE_STATUSES],
  );
  return rows[0];
};
