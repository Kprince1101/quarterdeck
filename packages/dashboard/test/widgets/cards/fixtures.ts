import type {
  AgentRow,
  CardRow,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import { DECK, NOW, ago } from '../events/fixtures.js';

export { DECK, NOW, PROJECTS, SITE, STRAY, ago } from '../events/fixtures.js';

export const MINUTE = 60_000;

export const MINK = '00000000-0000-4000-8000-0000000000a1';
export const TICKET = '00000000-0000-4000-8000-0000000000b1';

export const cardId = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const agent = (
  id: string,
  name: string,
  projectId = DECK,
): AgentRow => ({
  id,
  projectId,
  voyageId: null,
  name,
  role: 'builder',
  runtime: 'claude',
  status: 'working',
  sessionId: null,
  worktreePath: null,
  createdAt: ago(60 * MINUTE),
  updatedAt: ago(60 * MINUTE),
  endedAt: null,
});

export const ticket = (
  id: string,
  title: string,
  projectId = DECK,
): TicketRow => ({
  id,
  projectId,
  voyageId: null,
  assigneeId: MINK,
  title,
  body: '',
  status: 'in_progress',
  dependsOn: [],
  source: 'local',
  externalId: null,
  externalRef: null,
  prUrl: null,
  headSha: null,
  createdAt: ago(60 * MINUTE),
  updatedAt: ago(60 * MINUTE),
});

export const card = (n: number, fields: Partial<CardRow> = {}): CardRow => ({
  id: cardId(n),
  projectId: DECK,
  agentId: null,
  ticketId: null,
  kind: 'ask',
  question: `Question ${n}?`,
  options: [],
  checked: null,
  recommendation: null,
  status: 'open',
  answer: null,
  attachments: [],
  createdAt: ago(n * MINUTE),
  answeredAt: null,
  expiresAt: new Date(NOW + 60 * MINUTE).toISOString(),
  ...fields,
});

export const askCard = (n: number, fields: Partial<CardRow> = {}): CardRow =>
  card(n, {
    agentId: MINK,
    ticketId: TICKET,
    question: 'Which port should the dev server use?',
    checked: 'vite.config.ts sets none; README says 5173.',
    recommendation: '5173',
    ...fields,
  });

export const signInCard = (n: number, fields: Partial<CardRow> = {}): CardRow =>
  card(n, {
    agentId: MINK,
    kind: 'auth.sign_in',
    question:
      'Claude Code needs you to sign in. Run the command below in a terminal. Then answer "Signed in" and the session picks up where it stopped.',
    options: ['Signed in'],
    checked:
      'session/new failed with auth required: Authentication required. Quarterdeck never signs in for you.',
    recommendation: 'claude /login',
    ...fields,
  });

export const mergeCard = (n: number): CardRow =>
  card(n, {
    ticketId: TICKET,
    kind: 'ticket.merge',
    question:
      'Merge https://github.com/acme/deck/pull/7 for ticket "Cards widget" at abc123?\nmerge squash merges it; hold leaves it in review for you to merge on GitHub.',
    options: ['merge', 'hold'],
  });
