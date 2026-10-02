import type { Queryable, Store } from '../store/index.js';
import { TicketNotAssignableError } from './errors.js';

export const ACTIVE_TICKET_STATUSES: readonly string[] = [
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
  'blocked',
];

export const APPROVED_TICKET_STATUS = 'open';

export interface BuilderTicket {
  id: string;
  title: string;
  body: string;
  status: string;
  assigneeId: string | null;
  dependsOn: string[];
  prUrl: string | null;
  headSha: string | null;
}

export const TICKET_COLUMNS = `id, title, body, status, assignee_id as "assigneeId",
  depends_on as "dependsOn", pr_url as "prUrl", head_sha as "headSha"`;

export const findTicket = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
): Promise<BuilderTicket> => {
  const { rows } = await db.query<BuilderTicket>(
    `select ${TICKET_COLUMNS} from tickets
     where id = $1 and project_id = $2`,
    [ticketId, projectId],
  );
  const [ticket] = rows;
  if (!ticket)
    throw new TicketNotAssignableError(ticketId, 'it is not in this project');
  return ticket;
};

const unmetDependencies = async (
  store: Store,
  ticket: BuilderTicket,
): Promise<string[]> => {
  if (ticket.dependsOn.length === 0) return [];
  const { rows } = await store.db.query<{ id: string }>(
    `select id from tickets
     where project_id = $1 and id = any($2::uuid[]) and status <> 'done'
     order by id`,
    [store.projectId, ticket.dependsOn],
  );
  return rows.map((row) => row.id);
};

export const findApprovedTicket = async (
  store: Store,
  ticketId: string,
): Promise<BuilderTicket> => {
  const ticket = await findTicket(store.db, store.projectId, ticketId);
  if (ticket.status !== APPROVED_TICKET_STATUS)
    throw new TicketNotAssignableError(ticketId, `it is ${ticket.status}`);
  if (ticket.assigneeId !== null)
    throw new TicketNotAssignableError(
      ticketId,
      `it is assigned to ${ticket.assigneeId}`,
    );
  const unmet = await unmetDependencies(store, ticket);
  if (unmet.length > 0)
    throw new TicketNotAssignableError(
      ticketId,
      `it waits on ${unmet.join(', ')}`,
    );
  return ticket;
};

export const heldTickets = async (
  store: Store,
  agentId: string,
): Promise<BuilderTicket[]> => {
  const { rows } = await store.db.query<BuilderTicket>(
    `select ${TICKET_COLUMNS} from tickets
     where project_id = $1 and assignee_id = $2 and status = any($3)
     order by created_at, id`,
    [store.projectId, agentId, ACTIVE_TICKET_STATUSES],
  );
  return rows;
};
