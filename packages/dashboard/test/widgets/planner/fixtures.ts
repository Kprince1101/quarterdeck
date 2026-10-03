import type { StreamEvent, TicketRow } from '@quarterdeck/server/stream-schema';
import { DECK, ago } from '../events/fixtures.js';

export { DECK, PROJECTS, SITE, project } from '../events/fixtures.js';

export const PLANNER = '00000000-0000-4000-8000-0000000000a1';
export const SHIP = '00000000-0000-4000-8000-0000000000b1';
export const DOCS = '00000000-0000-4000-8000-0000000000b2';
export const INTENT_1 = '00000000-0000-4000-8000-0000000000c1';
export const INTENT_2 = '00000000-0000-4000-8000-0000000000c2';

interface EventInit {
  projectId?: string;
  ticketId?: string | null;
  payload?: Record<string, string>;
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

export const proposed = (id: number, ticketId: string, title: string) =>
  plannerEvent(id, 'ticket.proposed', { ticketId, payload: { title } });

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
  prUrl: null,
  headSha: null,
  createdAt: ago(0),
  updatedAt: ago(0),
  ...overrides,
});
