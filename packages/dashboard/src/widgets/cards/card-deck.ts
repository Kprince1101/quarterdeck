import type {
  AgentRow,
  CardRow,
  ProjectRow,
  SignInState,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import {
  storedImages,
  type MessageImage,
} from '../attachments/message-images.js';
import { relativeTime } from '../events/event-feed.js';

export const ASK_CARD = 'ask';
export const SIGN_IN_CARD = 'auth.sign_in';
export const MERGE_CARD = 'ticket.merge';

export const LOOKUP_LABEL = 'Could have looked that up';
export const ANSWER_IMAGES_LABEL = 'Images in the answer';
export const LOOKUP_NOTE =
  'You could have looked this up yourself; check before you ask next time.';

const LOOKUP_SUFFIX = `\n\n${LOOKUP_NOTE}`;

export type CardStatus = CardRow['status'];

export interface CardKind {
  label: string;
  checkedLabel: string;
  recommendationLabel: string;
  isCommand: boolean;
}

const KINDS: ReadonlyMap<string, CardKind> = new Map([
  [
    ASK_CARD,
    {
      label: 'Question',
      checkedLabel: 'Checked',
      recommendationLabel: 'Recommends',
      isCommand: false,
    },
  ],
  [
    SIGN_IN_CARD,
    {
      label: 'Sign in',
      checkedLabel: 'Why',
      recommendationLabel: 'Run',
      isCommand: true,
    },
  ],
  [
    MERGE_CARD,
    {
      label: 'Merge',
      checkedLabel: 'Checked',
      recommendationLabel: 'Recommends',
      isCommand: false,
    },
  ],
]);

export const cardKind = (kind: string): CardKind =>
  KINDS.get(kind) ?? {
    label: kind,
    checkedLabel: 'Checked',
    recommendationLabel: 'Recommends',
    isCommand: false,
  };

const STATUS_LABELS: Record<CardStatus, string> = {
  open: 'Open',
  answered: 'Answered',
  declined: 'Declined',
  expired: 'Expired',
};

export type SignInStatus = SignInState['status'];

const SIGN_IN_STATUS_LABELS: Record<SignInStatus, string> = {
  starting: 'Starting the sign-in...',
  waiting: 'Waiting for you to finish in the browser',
  signed_in: 'Signed in',
  failed: 'Automatic sign-in failed',
};

export interface SignInView {
  status: SignInStatus;
  statusLabel: string;
  url: string | null;
  code: string | null;
  isRunning: boolean;
}

const webUrl = (url: string | undefined): string | null => {
  if (url === undefined) return null;
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:') return url;
  } catch {
    return null;
  }
  return null;
};

export const toSignInView = (
  state: SignInState | null | undefined,
): SignInView | null => {
  if (!state) return null;
  return {
    status: state.status,
    statusLabel: SIGN_IN_STATUS_LABELS[state.status],
    url: webUrl(state.url),
    code: state.code ?? null,
    isRunning: state.status === 'starting' || state.status === 'waiting',
  };
};

export interface CardView {
  id: string;
  projectSlug: string | null;
  project: string;
  kind: string;
  label: string;
  question: string;
  options: string[];
  checked: string | null;
  checkedLabel: string;
  recommendation: string | null;
  recommendationLabel: string;
  isCommand: boolean;
  canFlagLookup: boolean;
  signIn: SignInView | null;
  from: string | null;
  ticket: string | null;
  status: CardStatus;
  statusLabel: string;
  answer: string | null;
  images: MessageImage[];
  hasImages: boolean;
  lookup: boolean;
  askedAt: string;
  askedAge: string;
  settledAt: string;
  settledAge: string;
}

export interface CardDeck {
  open: CardView[];
  answered: CardView[];
  isEmpty: boolean;
}

export interface CardDeckSource {
  cards: readonly CardRow[];
  projects: readonly ProjectRow[];
  agents: readonly AgentRow[];
  tickets: readonly TicketRow[];
  now: number;
}

export const withLookupNote = (answer: string, lookup: boolean): string => {
  if (!lookup) return answer;
  return `${answer}${LOOKUP_SUFFIX}`;
};

export const splitLookupNote = (
  answer: string | null,
): { text: string | null; lookup: boolean } => {
  if (answer === null || !answer.endsWith(LOOKUP_SUFFIX)) {
    return { text: answer, lookup: false };
  }
  return { text: answer.slice(0, -LOOKUP_SUFFIX.length), lookup: true };
};

export const cardOptions = (options: unknown): string[] => {
  if (!Array.isArray(options)) return [];
  return options.filter((option) => typeof option === 'string');
};

const settledAt = (card: CardRow): string =>
  card.answeredAt ?? card.expiresAt ?? card.createdAt;

const byId = <Row extends { id: string }>(
  rows: readonly Row[],
): ReadonlyMap<string, Row> => new Map(rows.map((row) => [row.id, row]));

interface Related {
  projects: ReadonlyMap<string, ProjectRow>;
  agents: ReadonlyMap<string, AgentRow>;
  tickets: ReadonlyMap<string, TicketRow>;
  now: number;
}

const nameOf = <Row>(
  rows: ReadonlyMap<string, Row>,
  id: string | null,
  name: (row: Row) => string,
): string | null => {
  if (id === null) return null;
  const row = rows.get(id);
  if (row === undefined) return null;
  return name(row);
};

const cardSignIn = (card: CardRow): SignInView | null => {
  if (card.kind !== SIGN_IN_CARD) return null;
  return toSignInView(card.signIn);
};

const shownRecommendation = (
  card: CardRow,
  signIn: SignInView | null,
): string | null => {
  if (signIn?.isRunning) return null;
  return card.recommendation;
};

export const toCardView = (card: CardRow, related: Related): CardView => {
  const kind = cardKind(card.kind);
  const options = cardOptions(card.options);
  const project = related.projects.get(card.projectId);
  const { text, lookup } = splitLookupNote(card.answer);
  const settled = settledAt(card);
  const signIn = cardSignIn(card);
  const images = storedImages(project?.slug ?? '', card.attachments);
  return {
    id: card.id,
    projectSlug: project?.slug ?? null,
    project: project?.name ?? card.projectId,
    kind: card.kind,
    label: kind.label,
    question: card.question,
    options,
    checked: card.checked,
    checkedLabel: kind.checkedLabel,
    recommendation: shownRecommendation(card, signIn),
    recommendationLabel: kind.recommendationLabel,
    isCommand: kind.isCommand,
    canFlagLookup: card.kind === ASK_CARD && options.length === 0,
    signIn,
    from: nameOf(related.agents, card.agentId, ({ name }) => name),
    ticket: nameOf(related.tickets, card.ticketId, ({ title }) => title),
    status: card.status,
    statusLabel: STATUS_LABELS[card.status],
    answer: text,
    images,
    hasImages: images.length > 0,
    lookup,
    askedAt: card.createdAt,
    askedAge: relativeTime(card.createdAt, related.now),
    settledAt: settled,
    settledAge: relativeTime(settled, related.now),
  };
};

const oldestFirst = (a: CardView, b: CardView): number =>
  Date.parse(a.askedAt) - Date.parse(b.askedAt);

const newestSettledFirst = (a: CardView, b: CardView): number =>
  Date.parse(b.settledAt) - Date.parse(a.settledAt);

export const cardDeck = ({
  cards,
  projects,
  agents,
  tickets,
  now,
}: CardDeckSource): CardDeck => {
  const related = {
    projects: byId(projects),
    agents: byId(agents),
    tickets: byId(tickets),
    now,
  };
  const views = cards.map((card) => toCardView(card, related));
  return {
    open: views.filter(({ status }) => status === 'open').toSorted(oldestFirst),
    answered: views
      .filter(({ status }) => status !== 'open')
      .toSorted(newestSettledFirst),
    isEmpty: cards.length === 0,
  };
};
