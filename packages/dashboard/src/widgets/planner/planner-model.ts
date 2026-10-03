import type {
  ProjectRow,
  StreamEvent,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import {
  SPEC_SECTIONS,
  parseTicketSpec,
  type SpecSection,
  type TicketSpec,
} from '@quarterdeck/server/ticket-spec';

export const PLANNER_HUMAN = 'planner.human';
export const PLANNER_REPLY = 'planner.reply';
export const PLANNER_FAILED = 'planner.failed';
export const PLANNER_CLEARED = 'planner.cleared';
export const PLANNER_NEW = 'planner.new';
export const PLANNER_MESSAGE = 'planner.message';
export const TICKET_PROPOSED = 'ticket.proposed';

export const GONE_LABEL = 'No longer on the board';

type TicketStatus = TicketRow['status'];

export type MessageAuthor = 'human' | 'planner' | 'failed' | 'pending';

export const AUTHOR_LABELS: Record<MessageAuthor, string> = {
  human: 'You',
  planner: 'Planner',
  failed: 'Not answered',
  pending: 'You, waiting for the Planner',
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  proposed: 'Proposed',
  open: 'Approved',
  assigned: 'Approved, assigned',
  in_progress: 'Approved, in progress',
  in_review: 'Approved, in review',
  bounced: 'Approved, bounced',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export interface ProjectChoice {
  id: string;
  slug: string;
  label: string;
}

export interface ChatMessage {
  author: MessageAuthor;
  authorLabel: string;
  text: string;
}

export interface Dependency {
  id: string;
  title: string;
}

export interface Proposal {
  ticketId: string;
  title: string;
  body: string;
  spec: TicketSpec | null;
  statusLabel: string;
  isDecidable: boolean;
  dependsOn: Dependency[];
}

export type SpecPart = 'intro' | SpecSection | 'proven';

export const SPEC_PART_LABELS: Record<SpecPart, string> = {
  intro: 'Summary',
  Requirements: 'Requirements',
  Design: 'Design',
  Tasks: 'Tasks',
  proven: 'Proven',
};

export interface SpecPartView {
  part: SpecPart;
  label: string;
  text: string;
}

export const SPEC_PART_ROWS: Record<SpecPart, number> = {
  intro: 2,
  Requirements: 4,
  Design: 4,
  Tasks: 4,
  proven: 1,
};

const introParts = (spec: TicketSpec): SpecPart[] => {
  if (spec.intro === '') return [];
  return ['intro'];
};

export const specParts = (spec: TicketSpec): SpecPart[] => [
  ...introParts(spec),
  ...SPEC_SECTIONS,
  'proven',
];

export const specPartText = (spec: TicketSpec, part: SpecPart): string => {
  if (part === 'intro') return spec.intro;
  if (part === 'proven') return spec.proven;
  return spec.sections[part];
};

export const withSpecPart = (
  spec: TicketSpec,
  part: SpecPart,
  text: string,
): TicketSpec => {
  if (part === 'intro') return { ...spec, intro: text };
  if (part === 'proven') return { ...spec, proven: text };
  return { ...spec, sections: { ...spec.sections, [part]: text } };
};

export const specPartViews = (
  spec: TicketSpec,
  parts: readonly SpecPart[] = specParts(spec),
): SpecPartView[] =>
  parts.map((part) => ({
    part,
    label: SPEC_PART_LABELS[part],
    text: specPartText(spec, part),
  }));

export interface ConversationEntry {
  key: string;
  message: ChatMessage | null;
  proposal: Proposal | null;
}

export interface PendingMessage {
  projectId: string;
  intentId: string;
  text: string;
}

const BOUNDARY_KINDS = new Set([PLANNER_CLEARED, PLANNER_NEW]);
const SETTLING_KINDS = new Set([PLANNER_HUMAN, PLANNER_FAILED]);

export const payloadText = (payload: unknown, key: string): string | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  return value;
};

export const projectChoices = (
  projects: readonly ProjectRow[],
): ProjectChoice[] =>
  projects
    .filter(({ archivedAt }) => archivedAt === null)
    .map(({ id, slug, name }) => ({ id, slug, label: name }))
    .toSorted((a, b) => a.label.localeCompare(b.label));

export const chosenProject = (
  choices: readonly ProjectChoice[],
  selectedId: string | null,
): ProjectChoice | null =>
  choices.find(({ id }) => id === selectedId) ?? choices[0] ?? null;

export const currentConversation = (
  events: readonly StreamEvent[],
  projectId: string,
): StreamEvent[] => {
  const own = events.filter((event) => event.projectId === projectId);
  const start = own.findLastIndex(({ kind }) => BOUNDARY_KINDS.has(kind));
  return own.slice(start + 1);
};

const message = (
  key: string,
  author: MessageAuthor,
  text: string,
): ConversationEntry => ({
  key,
  message: { author, authorLabel: AUTHOR_LABELS[author], text },
  proposal: null,
});

const dependenciesOf = (
  ids: readonly string[],
  tickets: ReadonlyMap<string, TicketRow>,
): Dependency[] =>
  ids.map((id) => ({ id, title: tickets.get(id)?.title ?? id }));

export const proposalOf = (
  ticketId: string,
  proposedTitle: string,
  tickets: ReadonlyMap<string, TicketRow>,
): Proposal => {
  const ticket = tickets.get(ticketId);
  if (ticket === undefined) {
    return {
      ticketId,
      title: proposedTitle,
      body: '',
      spec: null,
      statusLabel: GONE_LABEL,
      isDecidable: false,
      dependsOn: [],
    };
  }
  return {
    ticketId,
    title: ticket.title,
    body: ticket.body,
    spec: parseTicketSpec(ticket.body),
    statusLabel: STATUS_LABELS[ticket.status],
    isDecidable: ticket.status === 'proposed',
    dependsOn: dependenciesOf(ticket.dependsOn, tickets),
  };
};

const entryOf = (
  event: StreamEvent,
  tickets: ReadonlyMap<string, TicketRow>,
): ConversationEntry | null => {
  const key = `event-${event.id}`;
  const text = (field: string): string =>
    payloadText(event.payload, field) ?? '';
  if (event.kind === PLANNER_HUMAN) return message(key, 'human', text('text'));
  if (event.kind === PLANNER_REPLY) {
    return message(key, 'planner', text('text'));
  }
  if (event.kind === PLANNER_FAILED) {
    return message(key, 'failed', text('error'));
  }
  if (event.kind !== TICKET_PROPOSED || event.ticketId === null) return null;
  return {
    key,
    message: null,
    proposal: proposalOf(event.ticketId, text('title'), tickets),
  };
};

const lastBoundaryId = (events: readonly StreamEvent[]): number =>
  events.findLast(({ kind }) => BOUNDARY_KINDS.has(kind))?.id ?? 0;

const intentIdsOf = (
  events: readonly StreamEvent[],
  kinds: ReadonlySet<string>,
): Map<string, number> =>
  new Map(
    events
      .filter(({ kind }) => kinds.has(kind))
      .map((event) => [payloadText(event.payload, 'intentId') ?? '', event.id]),
  );

export const waitingMessages = (
  pending: readonly PendingMessage[],
  events: readonly StreamEvent[],
  projectId: string,
): PendingMessage[] => {
  const own = events.filter((event) => event.projectId === projectId);
  const settled = intentIdsOf(own, SETTLING_KINDS);
  const recorded = intentIdsOf(own, new Set([PLANNER_MESSAGE]));
  const boundary = lastBoundaryId(own);
  return pending.filter(
    ({ projectId: owner, intentId }) =>
      owner === projectId &&
      !settled.has(intentId) &&
      (recorded.get(intentId) ?? Infinity) > boundary,
  );
};

export interface ConversationSource {
  events: readonly StreamEvent[];
  tickets: readonly TicketRow[];
  pending: readonly PendingMessage[];
  projectId: string;
}

export const conversation = ({
  events,
  tickets,
  pending,
  projectId,
}: ConversationSource): ConversationEntry[] => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const entries = currentConversation(events, projectId)
    .map((event) => entryOf(event, byId))
    .filter((entry) => entry !== null);
  const waiting = waitingMessages(pending, events, projectId).map(
    ({ intentId, text }) => message(`pending-${intentId}`, 'pending', text),
  );
  return [...entries, ...waiting];
};
