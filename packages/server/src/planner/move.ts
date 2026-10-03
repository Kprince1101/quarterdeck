import type { ProjectStore } from './projects.js';

export const PROPOSAL_MOVED_EVENT = 'planner.proposal_moved';

export interface ProposalMove {
  ticketId: string;
  from: ProjectStore;
  to: ProjectStore;
  title?: string | undefined;
  body?: string | undefined;
}

export interface MovedProposal {
  ticketId: string;
  title: string;
}

export class ProposalMoveError extends Error {
  override name = 'ProposalMoveError';
  readonly missing: boolean;

  constructor(message: string, missing = false) {
    super(message);
    this.missing = missing;
  }
}

interface ProposedTicket {
  title: string;
  body: string;
  status: string;
}

const proposedTicket = async (
  store: ProjectStore,
  ticketId: string,
): Promise<ProposedTicket> => {
  const { rows } = await store.db.query<ProposedTicket>(
    `select title, body, status from tickets
     where id = $1 and project_id = $2`,
    [ticketId, store.projectId],
  );
  const [ticket] = rows;
  if (!ticket)
    throw new ProposalMoveError(`ticket ${ticketId} not found`, true);
  if (ticket.status !== 'proposed')
    throw new ProposalMoveError(
      `ticket ${ticketId} is ${ticket.status}, not proposed`,
    );
  return ticket;
};

const insertProposed = async (
  store: ProjectStore,
  title: string,
  body: string,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into tickets (project_id, title, body, status)
     values ($1, $2, $3, 'proposed') returning id`,
    [store.projectId, title, body],
  );
  const ticketId = rows[0]?.id;
  if (ticketId === undefined)
    throw new Error('the moved ticket was not stored');
  return ticketId;
};

const rejectProposed = async (
  store: ProjectStore,
  ticketId: string,
): Promise<boolean> => {
  const { rows } = await store.db.query(
    `update tickets set status = 'rejected'
     where id = $1 and project_id = $2 and status = 'proposed'
     returning id`,
    [ticketId, store.projectId],
  );
  return rows.length > 0;
};

export const moveProposal = async (
  move: ProposalMove,
): Promise<MovedProposal> => {
  const ticket = await proposedTicket(move.from, move.ticketId);
  const title = move.title ?? ticket.title;
  const ticketId = await insertProposed(
    move.to,
    title,
    move.body ?? ticket.body,
  );
  if (!(await rejectProposed(move.from, move.ticketId))) {
    await move.to.db.query('delete from tickets where id = $1', [ticketId]);
    throw new ProposalMoveError(
      `ticket ${move.ticketId} was decided while it was being moved`,
    );
  }
  return { ticketId, title };
};
