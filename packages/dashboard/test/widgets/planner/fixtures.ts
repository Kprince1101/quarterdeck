import type { StreamEvent, TicketRow } from '@quarterdeck/server/stream-schema';
import { DECK, ago } from '../events/fixtures.js';

export { DECK, PROJECTS, SITE, project } from '../events/fixtures.js';

export const PLANNER = '00000000-0000-4000-8000-0000000000a1';
export const SHIP = '00000000-0000-4000-8000-0000000000b1';
export const DOCS = '00000000-0000-4000-8000-0000000000b2';
export const INTENT_1 = '00000000-0000-4000-8000-0000000000c1';
export const INTENT_2 = '00000000-0000-4000-8000-0000000000c2';

export const SPEC_BODY = `## Requirements

- As a visitor, I want every page shipped.
  - WHEN the site builds THE SYSTEM SHALL publish every page.

## Design

Build with the site generator; touch nothing in the server.

## Tasks

1. Build the pages.
2. Publish them.

Proven: every page loads on the published site.`;

interface EventInit {
  projectId?: string;
  ticketId?: string | null;
  payload?: StreamEvent['payload'];
}

export const plannerEvent = (
  id: number,
  kind: string,
  { projectId = DECK, ticketId = null, payload = {} }: EventInit = {},
): StreamEvent => ({
  id,
  projectId,
  agentId: PLANNER,
  ticketId,
  kind,
  payload,
  createdAt: ago(0),
});

export const human = (id: number, text: string, intentId = INTENT_1) =>
  plannerEvent(id, 'planner.human', { payload: { intentId, seq: '1', text } });

export const reply = (id: number, text: string) =>
  plannerEvent(id, 'planner.reply', { payload: { text, stopReason: 'end' } });

const HOME_SLUG = 'deck';

const homeTicket = (project: string, ticketId: string): string | null => {
  if (project !== HOME_SLUG) return null;
  return ticketId;
};

export const proposed = (
  id: number,
  ticketId: string,
  title: string,
  project = HOME_SLUG,
) =>
  plannerEvent(id, 'ticket.proposed', {
    ticketId: homeTicket(project, ticketId),
    payload: { title, project, ticketId },
  });

export const moved = (
  id: number,
  from: { project: string; ticketId: string },
  to: { project: string; ticketId: string },
  title: string,
) =>
  plannerEvent(id, 'planner.proposal_moved', {
    payload: { ...from, title, to },
  });

export const LABELS: ReadonlyMap<string, string> = new Map([
  ['deck', 'Deck'],
  ['site', 'Site'],
]);

export const cleared = (id: number, projectId = DECK) =>
  plannerEvent(id, 'planner.cleared', {
    projectId,
    payload: { reason: 'new', intentId: INTENT_2 },
  });

export const ticket = (
  id: string,
  title: string,
  overrides: Partial<TicketRow> = {},
): TicketRow => ({
  id,
  projectId: DECK,
  voyageId: null,
  assigneeId: null,
  title,
  body: '',
  status: 'proposed',
  dependsOn: [],
  source: 'planner',
  externalId: null,
  externalRef: null,
  prUrl: null,
  headSha: null,
  createdAt: ago(0),
  updatedAt: ago(0),
  ...overrides,
});
