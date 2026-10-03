import type { Forge } from '@quarterdeck/rules/forges';
import type { OpenRequest, ProjectRequests } from '@quarterdeck/server/intents';
import type {
  ProjectRow,
  StreamEvent,
} from '@quarterdeck/server/stream-schema';

export const NOW = Date.parse('2026-10-03T12:00:00.000Z');
export const TICKET = '00000000-0000-4000-8000-0000000000a1';
export const AGENT = '00000000-0000-4000-8000-0000000000b1';
export const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

export const hoursAgo = (hours: number): string =>
  new Date(NOW - hours * 3_600_000).toISOString();

export const streamProject: ProjectRow = {
  id: PROJECT_ID,
  slug: 'example',
  name: 'example',
  repoPath: null,
  createdAt: hoursAgo(10),
  updatedAt: hoursAgo(10),
  archivedAt: null,
  pausedAt: null,
};

export const githubRequest = (
  number: number,
  changes: Partial<OpenRequest> = {},
): OpenRequest => ({
  url: `https://github.com/example-org/example/pull/${number}`,
  number,
  title: `Change ${number}`,
  author: 'okapi',
  branch: `topic-${number}`,
  base: 'main',
  draft: false,
  checks: 'passing',
  review: 'none',
  createdAt: hoursAgo(2),
  ticket: null,
  agent: null,
  ...changes,
});

export const gitlabRequest = (
  number: number,
  changes: Partial<OpenRequest> = {},
): OpenRequest =>
  githubRequest(number, {
    url: `https://gitlab.com/example-org/sample/-/merge_requests/${number}`,
    ...changes,
  });

export const linked = {
  ticket: { id: TICKET, title: 'Add the berth map', status: 'in_review' },
  agent: { id: AGENT, name: 'gannet' },
};

export const projectRequests = (
  project: string,
  forge: Forge,
  requests: OpenRequest[],
  error: string | null = null,
): ProjectRequests => ({
  project,
  name: project,
  forge,
  requests,
  error,
  fetchedAt: hoursAgo(0),
});

export const ticketEvent = (id: number, kind: string): StreamEvent => ({
  id,
  projectId: PROJECT_ID,
  agentId: null,
  ticketId: TICKET,
  kind,
  payload: {},
  createdAt: hoursAgo(0),
});
