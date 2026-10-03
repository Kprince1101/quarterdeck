import {
  forgeTerms,
  type Forge,
  type ForgeTerms,
} from '@quarterdeck/rules/forges';
import type { OpenRequest, ProjectRequests } from '@quarterdeck/server/intents';
import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { relativeTime } from '../events/event-feed.js';

export const NEUTRAL_TITLE = 'Pull and merge requests';
export const NEUTRAL_EMPTY = 'No open pull or merge requests';
export const NO_PROJECTS = 'No active project has a repository';

const NUMBER_PREFIX: Record<Forge, string> = { github: '#', gitlab: '!' };

const CHECKS_HEADING: Record<Forge, string> = {
  github: 'Checks',
  gitlab: 'Pipeline',
};

const CHECKS_LABEL: Record<OpenRequest['checks'], string> = {
  passing: 'Passing',
  pending: 'Running',
  failing: 'Failing',
  none: 'None',
};

const REVIEW_LABEL: Record<OpenRequest['review'], string> = {
  approved: 'Approved',
  changes: 'Changes requested',
  none: 'No review',
};

const UNKNOWN_AUTHOR = 'unknown';

export interface RequestRowView {
  key: string;
  url: string | null;
  numberLabel: string;
  openLabel: string;
  title: string;
  draft: boolean;
  author: string;
  branchLabel: string;
  checks: OpenRequest['checks'];
  checksLabel: string;
  review: OpenRequest['review'];
  reviewLabel: string;
  ticket: OpenRequest['ticket'];
  agent: string | null;
  age: string;
}

export interface ProjectRequestsView {
  project: string;
  name: string;
  forge: Forge;
  terms: ForgeTerms;
  columns: string[];
  rows: RequestRowView[];
  error: string | null;
  empty: string | null;
}

export interface RequestsView {
  title: string;
  empty: string | null;
  projects: ProjectRequestsView[];
}

const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export const forgeTitle = (terms: ForgeTerms): string =>
  `${capitalized(terms.long)}s`;

export const columnsFor = (forge: Forge): string[] => [
  forgeTerms(forge).short,
  'Title',
  'Author',
  'Branch',
  CHECKS_HEADING[forge],
  'Review',
  'Ticket',
  'Age',
];

const WEB_URL = /^https?:\/\//i;

export const linkable = (url: string): string | null => {
  if (!WEB_URL.test(url)) return null;
  return url;
};

const rowView = (
  forge: Forge,
  request: OpenRequest,
  now: number,
): RequestRowView => {
  const terms = forgeTerms(forge);
  const numberLabel = `${NUMBER_PREFIX[forge]}${request.number}`;
  return {
    key: request.url,
    url: linkable(request.url),
    numberLabel,
    openLabel: `Open ${terms.short} ${numberLabel} on ${terms.name}`,
    title: request.title,
    draft: request.draft,
    author: request.author ?? UNKNOWN_AUTHOR,
    branchLabel: `${request.branch} → ${request.base}`,
    checks: request.checks,
    checksLabel: CHECKS_LABEL[request.checks],
    review: request.review,
    reviewLabel: REVIEW_LABEL[request.review],
    ticket: request.ticket,
    agent: request.agent?.name ?? null,
    age: relativeTime(request.createdAt, now),
  };
};

const projectEmpty = (project: ProjectRequests, terms: ForgeTerms) => {
  if (project.error !== null || project.requests.length > 0) return null;
  return `No open ${terms.long}s`;
};

const projectView = (
  project: ProjectRequests,
  now: number,
): ProjectRequestsView => {
  const terms = forgeTerms(project.forge);
  return {
    project: project.project,
    name: project.name,
    forge: project.forge,
    terms,
    columns: columnsFor(project.forge),
    rows: project.requests.map((request) =>
      rowView(project.forge, request, now),
    ),
    error: project.error,
    empty: projectEmpty(project, terms),
  };
};

const onlyForge = (projects: readonly ProjectRequests[]): Forge | null => {
  const forges = new Set(projects.map(({ forge }) => forge));
  const [forge] = forges;
  if (forges.size !== 1 || forge === undefined) return null;
  return forge;
};

const titleOf = (forge: Forge | null): string => {
  if (forge === null) return NEUTRAL_TITLE;
  return forgeTitle(forgeTerms(forge));
};

const emptyOf = (
  projects: readonly ProjectRequests[],
  forge: Forge | null,
): string | null => {
  if (projects.length === 0) return NO_PROJECTS;
  const quiet = projects.every(
    ({ error, requests }) => error === null && requests.length === 0,
  );
  if (!quiet) return null;
  if (forge === null) return NEUTRAL_EMPTY;
  return `No open ${forgeTerms(forge).long}s`;
};

export const requestsView = (
  projects: readonly ProjectRequests[],
  now: number,
): RequestsView => {
  const forge = onlyForge(projects);
  const empty = emptyOf(projects, forge);
  const view: RequestsView = { title: titleOf(forge), empty, projects: [] };
  if (empty === null)
    view.projects = projects.map((project) => projectView(project, now));
  return view;
};

export const lastTicketEvent = (events: readonly StreamEvent[]): number =>
  Math.max(
    0,
    ...events
      .filter(({ kind }) => kind.startsWith('ticket.'))
      .map(({ id }) => id),
  );
