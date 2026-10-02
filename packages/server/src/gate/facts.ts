import { z } from 'zod';
import type { Queryable } from '../store/index.js';

export const GATE_EVENTS = {
  reported: 'ticket.reported',
  verdict: 'ticket.verdict',
  reviewRequested: 'ticket.review_requested',
  waiting: 'ticket.gate_waiting',
  bounced: 'ticket.gate_bounced',
  mergeRequested: 'ticket.merge_requested',
  merged: 'ticket.merged',
} as const;

export const MERGE_CARD = 'ticket.merge';
export const MERGE_ANSWER = 'merge';
export const HOLD_ANSWER = 'hold';

const sha = z.string().nullable();

const reportedSchema = z.object({
  pr: z.string(),
  head: sha,
  notes: z.string(),
  reviewerId: z.string().nullable(),
});

const verdictSchema = z.object({
  decision: z.enum(['approve', 'changes']),
  pr: z.string().nullable(),
  head: sha,
});

const waitingSchema = z.object({ reason: z.string() });

const mergeRequestedSchema = z.object({ cardId: z.string() });

export interface GateTicket {
  id: string;
  title: string;
  body: string;
  status: string;
  assigneeId: string | null;
}

export interface GateEvent {
  id: number;
  kind: string;
  agentId: string | null;
  payload: unknown;
}

export interface Report extends z.infer<typeof reportedSchema> {
  eventId: number;
}

export interface Verdict extends z.infer<typeof verdictSchema> {
  eventId: number;
}

export interface TicketFacts {
  ticket: GateTicket;
  report: Report | undefined;
  verdict: Verdict | undefined;
  reviewRequested: boolean;
  waitingFor: string | undefined;
  mergeCards: { eventId: number; cardId: string }[];
}

const TRACKED_KINDS: readonly string[] = Object.values(GATE_EVENTS);

export const readTicket = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
  lock = false,
): Promise<GateTicket | undefined> => {
  let sql = `select id, title, body, status, assignee_id as "assigneeId"
     from tickets where id = $1 and project_id = $2`;
  if (lock) sql += ' for update';
  const { rows } = await db.query<GateTicket>(sql, [ticketId, projectId]);
  return rows[0];
};

export const eventsSinceReport = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
): Promise<GateEvent[]> => {
  const { rows } = await db.query<GateEvent>(
    `select id, kind, agent_id as "agentId", payload from events
     where project_id = $1 and ticket_id = $2 and kind = any($3::text[])
       and id >= (
         select coalesce(max(id), 0) from events
         where project_id = $1 and ticket_id = $2 and kind = $4
       )
     order by id`,
    [projectId, ticketId, TRACKED_KINDS, GATE_EVENTS.reported],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
};

const lastOf = (events: GateEvent[], kind: string): GateEvent | undefined =>
  events.findLast((event) => event.kind === kind);

const parsed = <T>(
  schema: z.ZodType<T>,
  event: GateEvent | undefined,
): (T & { eventId: number }) | undefined => {
  if (event === undefined) return undefined;
  return { ...schema.parse(event.payload), eventId: event.id };
};

export const ticketFacts = (
  ticket: GateTicket,
  events: GateEvent[],
): TicketFacts => {
  const [first] = events;
  if (first?.kind !== GATE_EVENTS.reported)
    return {
      ticket,
      report: undefined,
      verdict: undefined,
      reviewRequested: false,
      waitingFor: undefined,
      mergeCards: [],
    };
  const last = events.at(-1);
  let waitingFor: string | undefined;
  if (last?.kind === GATE_EVENTS.waiting)
    waitingFor = waitingSchema.parse(last.payload).reason;
  return {
    ticket,
    report: parsed(reportedSchema, first),
    verdict: parsed(verdictSchema, lastOf(events, GATE_EVENTS.verdict)),
    reviewRequested: lastOf(events, GATE_EVENTS.reviewRequested) !== undefined,
    waitingFor,
    mergeCards: events
      .filter((event) => event.kind === GATE_EVENTS.mergeRequested)
      .map((event) => ({
        eventId: event.id,
        cardId: mergeRequestedSchema.parse(event.payload).cardId,
      })),
  };
};

export const readFacts = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
): Promise<TicketFacts | undefined> => {
  const ticket = await readTicket(db, projectId, ticketId);
  if (ticket === undefined) return undefined;
  return ticketFacts(ticket, await eventsSinceReport(db, projectId, ticketId));
};

export type MergeCardState = 'none' | 'open' | 'merge' | 'held';

export const mergeCardState = async (
  db: Queryable,
  projectId: string,
  cardId: string | undefined,
): Promise<MergeCardState> => {
  if (cardId === undefined) return 'none';
  const { rows } = await db.query<{ status: string; answer: string | null }>(
    'select status, answer from cards where id = $1 and project_id = $2',
    [cardId, projectId],
  );
  const [card] = rows;
  if (card === undefined) return 'held';
  if (card.status === 'open') return 'open';
  if (card.status === 'answered' && card.answer === MERGE_ANSWER)
    return 'merge';
  return 'held';
};
