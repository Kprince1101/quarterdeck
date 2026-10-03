import type { AgentRow, ProjectRow } from '@quarterdeck/server/stream-schema';

const CREATED = '2026-10-01T12:00:00.000Z';

export const projectId = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const agentId = (n: number): string =>
  `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

export const project = (
  n: number,
  name: string,
  overrides: Partial<ProjectRow> = {},
): ProjectRow => ({
  id: projectId(n),
  slug: name.toLowerCase(),
  name,
  repoPath: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  archivedAt: null,
  pausedAt: null,
  ...overrides,
});

export const agent = (
  n: number,
  project: number,
  fields: Pick<AgentRow, 'name' | 'role' | 'status'>,
): AgentRow => ({
  id: agentId(n),
  projectId: projectId(project),
  voyageId: null,
  runtime: 'claude',
  sessionId: null,
  worktreePath: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  endedAt: null,
  ...fields,
});
