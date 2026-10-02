import type {
  ProjectRow,
  StreamEvent,
} from '@quarterdeck/server/stream-schema';

export const NOW = Date.parse('2026-10-01T12:00:00.000Z');

export const DECK = '00000000-0000-4000-8000-000000000001';
export const SITE = '00000000-0000-4000-8000-000000000002';
export const STRAY = '00000000-0000-4000-8000-000000000003';

export const project = (id: string, name: string): ProjectRow => ({
  id,
  slug: name.toLowerCase(),
  name,
  repoPath: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  archivedAt: null,
});

export const PROJECTS: ProjectRow[] = [
  project(DECK, 'Deck'),
  project(SITE, 'Site'),
];

export const ago = (ms: number): string => new Date(NOW - ms).toISOString();

export const streamEvent = (
  id: number,
  kind: string,
  projectId: string,
  createdAt: string,
): StreamEvent => ({
  id,
  projectId,
  agentId: null,
  ticketId: null,
  kind,
  payload: {},
  createdAt,
});
