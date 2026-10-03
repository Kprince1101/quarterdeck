import type {
  AgentRow,
  SnapshotTables,
  StreamEvent,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import { emptyTables } from '../../../src/api/index.js';
import { PROJECT_ID, project } from '../notebook/fixtures.js';

export { OTHER_PROJECT_ID, PROJECT_ID, project } from '../notebook/fixtures.js';

export const NOW = Date.parse('2026-10-01T12:00:00.000Z');

export const DRIVER_ID = '00000000-0000-4000-8000-0000000000d1';
export const BUILDER_ID = '00000000-0000-4000-8000-0000000000b1';
export const PAUSED_ID = '00000000-0000-4000-8000-0000000000b2';
export const KILLED_ID = '00000000-0000-4000-8000-0000000000b3';
export const RETIRED_ID = '00000000-0000-4000-8000-0000000000b4';
export const TICKET_ID = '00000000-0000-4000-8000-0000000000c1';
export const REVIEW_TICKET_ID = '00000000-0000-4000-8000-0000000000c2';
export const DONE_TICKET_ID = '00000000-0000-4000-8000-0000000000c3';
export const BLOCKED_TICKET_ID = '00000000-0000-4000-8000-0000000000c4';
export const INTENT_ID = '00000000-0000-4000-8000-0000000000f1';

export const ago = (ms: number): string => new Date(NOW - ms).toISOString();

export const agent = (
  id: string,
  name: string,
  overrides: Partial<AgentRow> = {},
): AgentRow => ({
  id,
  projectId: PROJECT_ID,
  voyageId: null,
  name,
  role: 'builder',
  runtime: 'kiro',
  status: 'idle',
  sessionId: null,
  worktreePath: null,
  createdAt: ago(3_600_000),
  updatedAt: ago(0),
  endedAt: null,
  ...overrides,
});

export const ticket = (
  id: string,
  title: string,
  overrides: Partial<TicketRow> = {},
): TicketRow => ({
  id,
  projectId: PROJECT_ID,
  voyageId: null,
  assigneeId: null,
  title,
  body: '',
  status: 'open',
  dependsOn: [],
  source: 'local',
  externalId: null,
  externalRef: null,
  prUrl: null,
  headSha: null,
  createdAt: ago(600_000),
  updatedAt: ago(600_000),
  ...overrides,
});

export const failedEvent = (
  id: number,
  intentId: string,
  payload: Record<string, string> = { error: 'session would not close' },
): StreamEvent => ({
  id,
  projectId: PROJECT_ID,
  agentId: null,
  ticketId: null,
  kind: 'agent.intent_failed',
  payload: { intentId, intent: 'agent.kill', ...payload },
  createdAt: ago(0),
});

export const killedEvent = (id: number, intentId: string): StreamEvent => ({
  id,
  projectId: PROJECT_ID,
  agentId: BUILDER_ID,
  ticketId: null,
  kind: 'agent.killed',
  payload: { intentId, name: 'tansy', sessionId: null },
  createdAt: ago(0),
});

export const heldEvent = (
  id: number,
  agentId: string | null,
  label: string,
  scopes: string[] = ['agent'],
): StreamEvent => ({
  id,
  projectId: PROJECT_ID,
  agentId,
  ticketId: null,
  kind: 'pause.held',
  payload: { operation: 'continue', label, scopes },
  createdAt: ago(0),
});

export const replayedEvent = (id: number, held: StreamEvent): StreamEvent => ({
  ...held,
  id,
  kind: 'pause.replayed',
  payload: { operation: 'continue', label: 'replayed', heldEventId: held.id },
});

export const droppedEvent = (id: number, held: StreamEvent): StreamEvent => ({
  ...held,
  id,
  kind: 'pause.dropped',
  payload: {
    operation: 'continue',
    label: 'dropped',
    heldEventId: held.id,
    reason: 'aborted',
  },
});

export const agentsTables = (): SnapshotTables => ({
  ...emptyTables(),
  projects: [project(PROJECT_ID, 'deck')],
  agents: [
    agent(BUILDER_ID, 'tansy', {
      status: 'working',
      updatedAt: ago(5 * 60_000),
    }),
    agent(KILLED_ID, 'heron', { status: 'killed' }),
    agent(RETIRED_ID, 'owl', { status: 'retired' }),
    agent(PAUSED_ID, 'finch', {
      status: 'paused',
      updatedAt: ago(2 * 3_600_000),
    }),
    agent(DRIVER_ID, 'gull', { role: 'driver' }),
  ],
  tickets: [
    ticket(REVIEW_TICKET_ID, 'QD8a Board widget', {
      assigneeId: BUILDER_ID,
      status: 'in_review',
      createdAt: ago(900_000),
    }),
    ticket(TICKET_ID, 'QD8c Agents widget', {
      assigneeId: BUILDER_ID,
      status: 'in_progress',
    }),
    ticket(DONE_TICKET_ID, 'QD7b Widget grid', {
      assigneeId: BUILDER_ID,
      status: 'done',
    }),
    ticket(BLOCKED_TICKET_ID, 'QD5i kill / retire / reset', {
      assigneeId: KILLED_ID,
      status: 'blocked',
    }),
  ],
});
