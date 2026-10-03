import { GATE_EVENTS } from '../gate/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { Store, StoreEvent } from '../store/index.js';

export const TICKET_APPROVE_INTENT = 'ticket.approve';
export const TICKET_CREATE_INTENT = 'ticket.create';

const TICKET_INTENTS: readonly string[] = [
  TICKET_APPROVE_INTENT,
  TICKET_CREATE_INTENT,
];
export const TICKET_BLOCKED_EVENT = 'ticket.blocked';

export type NoteWake = 'event' | 'retry' | 'none';

export interface DriverNote {
  text: string;
  wake: NoteWake;
}

export interface NoteTicket {
  id: string;
  title: string;
  status: string;
  prUrl: string | null;
  builderId: string | null;
  builderName: string | null;
}

export const DRIVER_NOTE_KINDS: readonly string[] = [
  ...TICKET_INTENTS,
  GATE_EVENTS.reported,
  GATE_EVENTS.verdict,
  GATE_EVENTS.bounced,
  GATE_EVENTS.merged,
  TICKET_BLOCKED_EVENT,
];

type Payload = Record<string, unknown>;

const payloadOf = (event: StoreEvent): Payload => {
  if (typeof event.payload !== 'object' || event.payload === null) return {};
  return event.payload as Payload;
};

const textOf = (payload: Payload, key: string): string => {
  const value = payload[key];
  if (typeof value === 'string') return value;
  return '';
};

export const readNoteTicket = async (
  store: Pick<Store, 'db' | 'projectId'>,
  ticketId: string,
): Promise<NoteTicket | undefined> => {
  const { rows } = await store.db.query<NoteTicket>(
    `select t.id, t.title, t.status, t.pr_url as "prUrl",
       a.id as "builderId", a.name as "builderName"
     from tickets t left join agents a on a.id = t.assignee_id
     where t.id = $1 and t.project_id = $2`,
    [ticketId, store.projectId],
  );
  return rows[0];
};

export const intentTicketId = async (
  store: Pick<Store, 'db' | 'projectId'>,
  event: StoreEvent,
): Promise<string | undefined> => {
  const payload = payloadOf(event);
  if (payload['status'] !== 'applied') return undefined;
  const { rows } = await store.db.query<{ ticketId: string | null }>(
    `select coalesce(result ->> 'ticketId', input ->> 'ticketId') as "ticketId"
     from intents where id = $1 and project_id = $2`,
    [textOf(payload, 'intentId'), store.projectId],
  );
  return rows[0]?.ticketId ?? undefined;
};

export const ticketLabel = (ticket: Pick<NoteTicket, 'id' | 'title'>): string =>
  `"${ticket.title}" (ticket ${ticket.id})`;

export const builderLabel = (ticket: NoteTicket): string => {
  if (ticket.builderId === null) return 'no builder';
  return `${ticket.builderName ?? 'a builder'} (builder ${ticket.builderId})`;
};

const verdictText = (ticket: NoteTicket, payload: Payload): string => {
  if (payload['decision'] === 'approve')
    return `The reviewer approved ${ticketLabel(ticket)}; the merge gate has it now.`;
  return `The reviewer asked for changes on ${ticketLabel(ticket)}, held by ${builderLabel(ticket)}: ${textOf(payload, 'notes')}`;
};

type NoteText = (ticket: NoteTicket, payload: Payload) => string;

const NOTE_TEXTS: Record<string, NoteText> = {
  [TICKET_APPROVE_INTENT]: (ticket) =>
    `Ticket approved: ${ticketLabel(ticket)}. Assign it once its dependencies are done.`,
  [TICKET_CREATE_INTENT]: (ticket) =>
    `Ticket approved: ${ticketLabel(ticket)}, created on the board. Assign it once its dependencies are done.`,
  [GATE_EVENTS.reported]: (ticket, payload) =>
    `${builderLabel(ticket)} reported ${ticketLabel(ticket)}: ${textOf(payload, 'pr')}. It is in review.`,
  [GATE_EVENTS.verdict]: verdictText,
  [GATE_EVENTS.bounced]: (ticket, payload) =>
    `The merge gate bounced ${ticketLabel(ticket)}, held by ${builderLabel(ticket)}: ${textOf(payload, 'reason')}`,
  [GATE_EVENTS.merged]: (ticket, payload) =>
    `${ticketLabel(ticket)} merged: ${textOf(payload, 'pr')}.`,
  [TICKET_BLOCKED_EVENT]: (ticket) =>
    `${ticketLabel(ticket)} is blocked: its builder was killed.`,
};

const eventTicketId = async (
  store: Pick<Store, 'db' | 'projectId'>,
  event: StoreEvent,
): Promise<string | undefined> => {
  if (TICKET_INTENTS.includes(event.kind)) return intentTicketId(store, event);
  return event.ticketId ?? undefined;
};

export const noteForEvent = async (
  store: Pick<Store, 'db' | 'projectId'>,
  event: StoreEvent,
): Promise<DriverNote | undefined> => {
  const write = NOTE_TEXTS[event.kind];
  if (write === undefined) return undefined;
  const ticketId = await eventTicketId(store, event);
  if (ticketId === undefined) return undefined;
  const ticket = await readNoteTicket(store, ticketId);
  if (ticket === undefined) return undefined;
  return { text: write(ticket, payloadOf(event)), wake: 'event' };
};

export interface NoteBuilder {
  id: string;
  name: string;
}

export const builderTurnNote = (
  builder: NoteBuilder,
  stopReason: string,
  ticket: NoteTicket | undefined,
): DriverNote => {
  const ended = `${builder.name} (builder ${builder.id}) ended its turn with ${stopReason}`;
  if (ticket === undefined) return { text: `${ended}.`, wake: 'event' };
  return {
    text: `${ended} on ${ticketLabel(ticket)}; the ticket is ${ticket.status}.`,
    wake: 'event',
  };
};

export const builderFailedNote = (
  builder: NoteBuilder,
  err: unknown,
): DriverNote => ({
  text: `${builder.name} (builder ${builder.id}) failed its turn: ${getErrorMessage(err)}`,
  wake: 'event',
});

export const actionDoneNote = (text: string): DriverNote => ({
  text,
  wake: 'none',
});

export const actionFailedNote = (
  action: unknown,
  error: string,
): DriverNote => ({
  text: `Your action ${JSON.stringify(action)} was not carried out: ${error}`,
  wake: 'retry',
});

export const humanNote = (text: string): DriverNote => ({
  text: `Message from the human: ${text}`,
  wake: 'event',
});

export const readWaitingTickets = async (
  store: Pick<Store, 'db' | 'projectId'>,
): Promise<Pick<NoteTicket, 'id' | 'title'>[]> => {
  const { rows } = await store.db.query<Pick<NoteTicket, 'id' | 'title'>>(
    `select id, title from tickets
     where project_id = $1 and status = 'open' and assignee_id is null
     order by created_at, id`,
    [store.projectId],
  );
  return rows;
};

export const waitingTicketsNote = (
  tickets: readonly Pick<NoteTicket, 'id' | 'title'>[],
): DriverNote => ({
  text: `Approved tickets waiting for a builder: ${tickets.map(ticketLabel).join(', ')}.`,
  wake: 'event',
});

export const projectNote = (project: string, note: DriverNote): DriverNote => ({
  ...note,
  text: `[${project}] ${note.text}`,
});

export const composeTurnInput = (notes: readonly DriverNote[]): string =>
  [
    '# Since your last turn',
    notes.map((note) => `- ${note.text}`).join('\n'),
    'Decide what to do next and end with your turn result.',
  ].join('\n\n');
