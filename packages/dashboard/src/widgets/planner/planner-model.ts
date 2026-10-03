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
export const PROPOSAL_MOVED = 'planner.proposal_moved';

export const GONE_LABEL = 'No longer on the board';

export const elsewhereLabel = (projectLabel: string): string =>
  `On the ${projectLabel} board`;

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
  project: string;
  projectLabel: string;
  title: string;
  body: string;
  spec: TicketSpec | null;
  statusLabel: string;
  isDecidable: boolean;
  isOnBoard: boolean;
  dependsOn: Dependency[];
}

export interface ProposalPlace {
  project: string;
  projectLabel: string;
  isHome: boolean;
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

export const homeProject = (
  choices: readonly ProjectChoice[],
): ProjectChoice | null => choices[0] ?? null;

export const projectLabels = (
  projects: readonly ProjectRow[],
): ReadonlyMap<string, string> =>
  new Map(projects.map(({ slug, name }) => [slug, name]));

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

const missingLabel = (place: ProposalPlace): string => {
  if (place.isHome) return GONE_LABEL;
  return elsewhereLabel(place.projectLabel);
};

export const proposalOf = (
  ticketId: string,
  proposedTitle: string,
  tickets: ReadonlyMap<string, TicketRow>,
  place: ProposalPlace,
): Proposal => {
  const ticket = tickets.get(ticketId);
  const { project, projectLabel } = place;
  if (ticket === undefined) {
    return {
      ticketId,
      project,
      projectLabel,
      title: proposedTitle,
      body: '',
      spec: null,
      statusLabel: missingLabel(place),
      isDecidable: !place.isHome,
      isOnBoard: false,
      dependsOn: [],
    };
  }
  return {
    ticketId,
    project,
    projectLabel,
    title: ticket.title,
    body: ticket.body,
    spec: parseTicketSpec(ticket.body),
    statusLabel: STATUS_LABELS[ticket.status],
    isDecidable: ticket.status === 'proposed',
    isOnBoard: true,
    dependsOn: dependenciesOf(ticket.dependsOn, tickets),
  };
};

interface ProposalSpot {
  project: string;
  ticketId: string;
  title: string;
}

const movesOf = (
  events: readonly StreamEvent[],
): ReadonlyMap<string, ProposalSpot> =>
  new Map(
    events
      .filter(({ kind }) => kind === PROPOSAL_MOVED)
      .flatMap((event) => {
        const from = payloadText(event.payload, 'ticketId');
        const to = (event.payload as { to?: unknown }).to;
        const project = payloadText(to, 'project');
        const ticketId = payloadText(to, 'ticketId');
        if (from === null || project === null || ticketId === null) return [];
        const title = payloadText(event.payload, 'title') ?? '';
        return [[from, { project, ticketId, title }] as const];
      }),
  );

const followMoves = (
  spot: ProposalSpot,
  moves: ReadonlyMap<string, ProposalSpot>,
): ProposalSpot => {
  let current = spot;
  for (let hops = 0; hops <= moves.size; hops += 1) {
    const next = moves.get(current.ticketId);
    if (next === undefined) return current;
    current = next;
  }
  return current;
};

interface ConversationPlace {
  homeSlug: string;
  labels: ReadonlyMap<string, string>;
  moves: ReadonlyMap<string, ProposalSpot>;
}

const proposalEntry = (
  event: StreamEvent,
  tickets: ReadonlyMap<string, TicketRow>,
  place: ConversationPlace,
): Proposal | null => {
  const ticketId = payloadText(event.payload, 'ticketId') ?? event.ticketId;
  if (ticketId === null) return null;
  const spot = followMoves(
    {
      ticketId,
      project: payloadText(event.payload, 'project') ?? place.homeSlug,
      title: payloadText(event.payload, 'title') ?? '',
    },
    place.moves,
  );
  return proposalOf(spot.ticketId, spot.title, tickets, {
    project: spot.project,
    projectLabel: place.labels.get(spot.project) ?? spot.project,
    isHome: spot.project === place.homeSlug,
  });
};

const entryOf = (
  event: StreamEvent,
  tickets: ReadonlyMap<string, TicketRow>,
  place: ConversationPlace,
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
  if (event.kind !== TICKET_PROPOSED) return null;
  const proposal = proposalEntry(event, tickets, place);
  if (proposal === null) return null;
  return { key, message: null, proposal };
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
  homeSlug: string;
  labels: ReadonlyMap<string, string>;
}

export const conversation = ({
  events,
  tickets,
  pending,
  projectId,
  homeSlug,
  labels,
}: ConversationSource): ConversationEntry[] => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const own = currentConversation(events, projectId);
  const place = { homeSlug, labels, moves: movesOf(own) };
  const entries = own
    .map((event) => entryOf(event, byId, place))
    .filter((entry) => entry !== null);
  const waiting = waitingMessages(pending, events, projectId).map(
    ({ intentId, text }) => message(`pending-${intentId}`, 'pending', text),
  );
  return [...entries, ...waiting];
};
