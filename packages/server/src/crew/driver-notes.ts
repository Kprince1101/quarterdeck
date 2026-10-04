import {
  DEPENDENCIES_REASON,
  TICKET_PUBLISHED_EVENT,
  TICKET_UNBLOCKED_EVENT,
  TICKET_WAITING_EVENT,
} from '../driver/index.js';
import { GATE_EVENTS } from '../gate/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { Store, StoreEvent } from '../store/index.js';
import { TICKET_REOPENED_EVENT } from '../voyage-end/index.js';

export const TICKET_APPROVE_INTENT = 'ticket.approve';
export const TICKET_CREATE_INTENT = 'ticket.create';
export const TICKET_UPDATE_INTENT = 'ticket.update';

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
  TICKET_WAITING_EVENT,
  TICKET_UNBLOCKED_EVENT,
];

export const WAKE_EVENT_KINDS: readonly string[] = [
  ...TICKET_INTENTS,
  TICKET_UPDATE_INTENT,
  GATE_EVENTS.merged,
  TICKET_BLOCKED_EVENT,
  TICKET_PUBLISHED_EVENT,
  TICKET_REOPENED_EVENT,
];

export interface NoteContext {
  publishes?: boolean;
}

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

type NoteText = (
  ticket: NoteTicket,
  payload: Payload,
  context: NoteContext,
) => string;

const listOf = (payload: Payload, key: string): Payload[] => {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Payload => typeof item === 'object' && item !== null,
  );
};

const dependencyText = (dependency: Payload): string => {
  const id = textOf(dependency, 'ticket');
  const project = textOf(dependency, 'project');
  if (project === '') return id;
  return `${id} ("${textOf(dependency, 'title')}", project ${project})`;
};

const readyText = (dependency: Payload): string => {
  const name = textOf(dependency, 'package');
  if (name === '') return `${dependencyText(dependency)} merged`;
  return `${dependencyText(dependency)} published as ${name} ${textOf(dependency, 'version')}`;
};

const unmetText = (payload: Payload): string =>
  listOf(payload, 'unmet')
    .map(
      (dependency) =>
        `${dependencyText(dependency)}: ${textOf(dependency, 'reason')}`,
    )
    .join('; ');

const noteSuffix = (payload: Payload): string => {
  const note = textOf(payload, 'note');
  if (note === '') return '';
  return ` Note: ${note}`;
};

const blockedText: NoteText = (ticket, payload) => {
  if (payload['reason'] !== DEPENDENCIES_REASON)
    return `${ticketLabel(ticket)} is blocked: its builder was killed.`;
  return `${ticketLabel(ticket)} is blocked, held by ${builderLabel(ticket)}, waiting on ${unmetText(payload)}. Quarterdeck continues the builder once they are satisfied.${noteSuffix(payload)}`;
};

const unblockedText: NoteText = (ticket, payload) => {
  const ready = listOf(payload, 'dependencies').map(readyText).join('; ');
  if (payload['held'] === true)
    return `${ticketLabel(ticket)} is unblocked and ${ticket.status} again: ${ready}. Quarterdeck continues ${builderLabel(ticket)} with these versions.`;
  return `${ticketLabel(ticket)} is ready to assign: ${ready}.`;
};

const mergedText: NoteText = (ticket, payload, context) => {
  const merged = `${ticketLabel(ticket)} merged: ${textOf(payload, 'pr')}.`;
  if (context.publishes !== true) return merged;
  return `${merged} Its project publishes, so it needs publishing: publish it with your shell and the project's CLI, then send \`published\` with the package and version.`;
};

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
  [GATE_EVENTS.merged]: mergedText,
  [TICKET_BLOCKED_EVENT]: blockedText,
  [TICKET_WAITING_EVENT]: (ticket, payload) =>
    `${ticketLabel(ticket)} waits on ${unmetText(payload)}; assign it once they are satisfied.`,
  [TICKET_UNBLOCKED_EVENT]: unblockedText,
};

const QUIET_KINDS: readonly string[] = [TICKET_WAITING_EVENT];

const wakeOf = (event: StoreEvent, payload: Payload): NoteWake => {
  if (QUIET_KINDS.includes(event.kind)) return 'none';
  if (event.kind === TICKET_UNBLOCKED_EVENT && payload['held'] === true)
    return 'none';
  if (
    event.kind === TICKET_BLOCKED_EVENT &&
    payload['reason'] === DEPENDENCIES_REASON
  )
    return 'none';
  return 'event';
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
  context: NoteContext = {},
): Promise<DriverNote | undefined> => {
  const write = NOTE_TEXTS[event.kind];
  if (write === undefined) return undefined;
  const ticketId = await eventTicketId(store, event);
  if (ticketId === undefined) return undefined;
  const ticket = await readNoteTicket(store, ticketId);
  if (ticket === undefined) return undefined;
  const payload = payloadOf(event);
  return {
    text: write(ticket, payload, context),
    wake: wakeOf(event, payload),
  };
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

export const wakeFailedNote = (
  ticket: Pick<NoteTicket, 'id' | 'title'>,
  builder: string,
  error: string,
): DriverNote => ({
  text: `${ticketLabel(ticket)} is unblocked, but Quarterdeck could not continue ${builder}: ${error}. Continue or reassign it yourself with the versions it waited on.`,
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
