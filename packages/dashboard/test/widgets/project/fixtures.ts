import type {
  AgentRow,
  ProjectRow,
  VoyageRow,
  SnapshotTables,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import { emptyTables } from '../../../src/api/index.js';

export const DECK_ID = '00000000-0000-4000-8000-000000000001';
export const SITE_ID = '00000000-0000-4000-8000-000000000002';
export const OLD_ID = '00000000-0000-4000-8000-000000000003';
export const ENDED_VOYAGE_ID = '00000000-0000-4000-8000-0000000000b1';
export const VOYAGE_ID = '00000000-0000-4000-8000-0000000000b2';
export const IDLE_BUILDER_ID = '00000000-0000-4000-8000-0000000000c1';
export const IDLE_REVIEWER_ID = '00000000-0000-4000-8000-0000000000c2';
export const WORKING_BUILDER_ID = '00000000-0000-4000-8000-0000000000c3';
export const IDLE_DRIVER_ID = '00000000-0000-4000-8000-0000000000c4';
export const RETIRED_ID = '00000000-0000-4000-8000-0000000000c5';
export const KILLED_REVIEWER_ID = '00000000-0000-4000-8000-0000000000c6';
export const SITE_RETIRED_ID = '00000000-0000-4000-8000-0000000000c7';
export const BUSY_BUILDER_ID = '00000000-0000-4000-8000-0000000000c8';

const ticketId = (n: number): string =>
  `00000000-0000-4000-8000-0000000000d${n}`;

const AT = '2026-10-01T12:00:00.000Z';

const at = (second: number): string =>
  `2026-10-01T12:00:${String(second).padStart(2, '0')}.000Z`;

export const project = (
  id: string,
  slug: string,
  name: string,
  overrides: Partial<ProjectRow> = {},
): ProjectRow => ({
  id,
  slug,
  name,
  repoPath: null,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  pausedAt: null,
  ...overrides,
});

export const voyage = (
  id: string,
  number: number,
  overrides: Partial<VoyageRow> = {},
): VoyageRow => ({
  id,
  projectId: DECK_ID,
  number,
  status: 'active',
  goal: 'Ship the project widget',
  startedAt: AT,
  endedAt: null,
  ...overrides,
});

export const agent = (
  id: string,
  name: string,
  overrides: Partial<AgentRow> = {},
): AgentRow => ({
  id,
  projectId: DECK_ID,
  voyageId: null,
  name,
  role: 'builder',
  runtime: 'claude',
  status: 'idle',
  sessionId: null,
  worktreePath: null,
  createdAt: AT,
  updatedAt: AT,
  endedAt: null,
  ...overrides,
});

export const ticket = (
  n: number,
  assigneeId: string | null,
  status: TicketRow['status'],
): TicketRow => ({
  id: ticketId(n),
  projectId: DECK_ID,
  voyageId: VOYAGE_ID,
  assigneeId,
  title: `Ticket ${n}`,
  body: '',
  status,
  dependsOn: [],
  source: 'local',
  externalId: null,
  prUrl: null,
  headSha: null,
  createdAt: AT,
  updatedAt: AT,
});

export const projectTables = (): SnapshotTables => ({
  ...emptyTables(),
  projects: [
    project(OLD_ID, 'old', 'Archive Me', { archivedAt: at(9) }),
    project(SITE_ID, 'site', 'Site'),
    project(DECK_ID, 'deck', 'Deck'),
  ],
  voyages: [
    voyage(ENDED_VOYAGE_ID, 1, { status: 'ended', endedAt: at(5) }),
    voyage(VOYAGE_ID, 2),
  ],
  agents: [
    agent(IDLE_REVIEWER_ID, 'tern', { role: 'reviewer', createdAt: at(3) }),
    agent(IDLE_BUILDER_ID, 'quill', { createdAt: at(1) }),
    agent(BUSY_BUILDER_ID, 'plover', { voyageId: VOYAGE_ID, createdAt: at(2) }),
    agent(WORKING_BUILDER_ID, 'heron', {
      voyageId: VOYAGE_ID,
      status: 'working',
    }),
    agent(IDLE_DRIVER_ID, 'kite', { role: 'driver', voyageId: VOYAGE_ID }),
    agent(RETIRED_ID, 'gull', { voyageId: VOYAGE_ID, status: 'retired' }),
    agent(KILLED_REVIEWER_ID, 'skua', { role: 'reviewer', status: 'killed' }),
    agent(SITE_RETIRED_ID, 'wren', { projectId: SITE_ID, status: 'retired' }),
  ],
  tickets: [
    ticket(1, BUSY_BUILDER_ID, 'in_progress'),
    ticket(2, WORKING_BUILDER_ID, 'in_review'),
    ticket(3, RETIRED_ID, 'bounced'),
    ticket(4, IDLE_BUILDER_ID, 'done'),
    ticket(5, null, 'open'),
    ticket(6, IDLE_DRIVER_ID, 'assigned'),
  ],
});
