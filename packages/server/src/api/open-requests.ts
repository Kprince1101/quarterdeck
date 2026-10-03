import { DEFAULT_FORGE, type Forge } from '@quarterdeck/rules';
import {
  GATE_EVENTS,
  forgeHost,
  originRepository,
  repositoryForge,
  type ForgeHost,
  type OpenPullRequest,
} from '../gate/index.js';
import type { OpenRequest, ProjectRequests } from '../intents/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { Queryable, Store } from '../store/index.js';
import type { ProjectStores } from './project-stores.js';

export const OPEN_REQUESTS_REFRESH_MS = 60_000;

const TICKET_PREFIX_LENGTH = 8;

const GATE_KINDS: readonly string[] = Object.values(GATE_EVENTS);

export type ForgeHosts = (forge: Forge) => ForgeHost;

export interface OpenRequestsOptions {
  stores: ProjectStores;
  homeDir: string;
  hosts?: ForgeHosts | undefined;
  refreshMs?: number | undefined;
  now?: (() => number) | undefined;
}

export interface OpenRequests {
  read: () => Promise<ProjectRequests[]>;
}

interface ProjectFacts {
  name: string;
  repoPath: string | null;
  archived: boolean;
}

interface Listing {
  repoPath: string;
  gateMark: number;
  fetchedAt: number;
  forge: Forge;
  requests: OpenPullRequest[];
  error: string | null;
}

interface TicketLink {
  id: string;
  title: string;
  status: string;
  prUrl: string | null;
  agentId: string | null;
  agentName: string | null;
}

const projectFacts = async (
  store: Store,
): Promise<ProjectFacts | undefined> => {
  const { rows } = await store.db.query<ProjectFacts>(
    `select name, repo_path as "repoPath", archived_at is not null as archived
     from projects where id = $1`,
    [store.projectId],
  );
  return rows[0];
};

const gateMark = async (db: Queryable, projectId: string): Promise<number> => {
  const { rows } = await db.query<{ mark: string | number | null }>(
    `select max(id) as mark from events
     where project_id = $1 and kind = any($2::text[])`,
    [projectId, GATE_KINDS],
  );
  return Number(rows[0]?.mark ?? 0);
};

const ticketLinks = async (
  db: Queryable,
  projectId: string,
): Promise<TicketLink[]> => {
  const { rows } = await db.query<TicketLink>(
    `select t.id, t.title, t.status, t.pr_url as "prUrl",
       a.id as "agentId", a.name as "agentName"
     from tickets t left join agents a on a.id = t.assignee_id
     where t.project_id = $1
     order by t.updated_at desc`,
    [projectId],
  );
  return rows;
};

const comparableUrl = (url: string): string =>
  url.trim().replace(/\/+$/, '').toLowerCase();

const branchNamesTicket = (branch: string, ticketId: string): boolean => {
  const prefix = ticketId.slice(0, TICKET_PREFIX_LENGTH).toLowerCase();
  return new RegExp(`(^|[^0-9a-f])${prefix}($|[^0-9a-f])`).test(
    branch.toLowerCase(),
  );
};

export const linkTicket = <T extends Pick<TicketLink, 'id' | 'prUrl'>>(
  request: Pick<OpenPullRequest, 'url' | 'branch'>,
  tickets: readonly T[],
): T | undefined => {
  const url = comparableUrl(request.url);
  return (
    tickets.find(
      (ticket) => ticket.prUrl !== null && comparableUrl(ticket.prUrl) === url,
    ) ?? tickets.find((ticket) => branchNamesTicket(request.branch, ticket.id))
  );
};

const agentOf = (ticket: TicketLink | undefined): OpenRequest['agent'] => {
  if (!ticket?.agentId || ticket.agentName === null) return null;
  return { id: ticket.agentId, name: ticket.agentName };
};

const ticketOf = (ticket: TicketLink | undefined): OpenRequest['ticket'] => {
  if (ticket === undefined) return null;
  return { id: ticket.id, title: ticket.title, status: ticket.status };
};

const openRequest = (
  request: OpenPullRequest,
  tickets: readonly TicketLink[],
): OpenRequest => {
  const ticket = linkTicket(request, tickets);
  return {
    url: request.url,
    number: request.number,
    title: request.title,
    author: request.author,
    branch: request.branch,
    base: request.base,
    draft: request.draft,
    checks: request.checks,
    review: request.review,
    createdAt: request.createdAt,
    ticket: ticketOf(ticket),
    agent: agentOf(ticket),
  };
};

const failedProject = (
  project: string,
  error: unknown,
  at: number,
): ProjectRequests => ({
  project,
  name: project,
  forge: DEFAULT_FORGE,
  requests: [],
  error: getErrorMessage(error),
  fetchedAt: new Date(at).toISOString(),
});

export const createOpenRequests = ({
  stores,
  homeDir,
  hosts = forgeHost,
  refreshMs = OPEN_REQUESTS_REFRESH_MS,
  now = Date.now,
}: OpenRequestsOptions): OpenRequests => {
  const cache = new Map<string, Listing>();
  const fetching = new Map<string, Promise<Listing>>();

  const list = async (repoPath: string, mark: number): Promise<Listing> => {
    const listing: Listing = {
      repoPath,
      gateMark: mark,
      fetchedAt: now(),
      forge: DEFAULT_FORGE,
      requests: [],
      error: null,
    };
    try {
      const repository = await originRepository(repoPath);
      listing.forge = await repositoryForge(repository, {
        repoDir: repoPath,
        homeDir,
      });
      listing.requests = await hosts(listing.forge).listOpen(repository);
    } catch (err) {
      listing.error = getErrorMessage(err);
    }
    return listing;
  };

  const isFresh = (listing: Listing, repoPath: string, mark: number) =>
    listing.repoPath === repoPath &&
    listing.gateMark === mark &&
    now() - listing.fetchedAt < refreshMs;

  const listing = async (
    project: string,
    repoPath: string,
    mark: number,
  ): Promise<Listing> => {
    const cached = cache.get(project);
    if (cached && isFresh(cached, repoPath, mark)) return cached;
    const running = fetching.get(project);
    if (running) return running;
    const next = list(repoPath, mark).then((fresh) => {
      cache.set(project, fresh);
      return fresh;
    });
    fetching.set(project, next);
    try {
      return await next;
    } finally {
      fetching.delete(project);
    }
  };

  const readProject = async (
    project: string,
  ): Promise<ProjectRequests | undefined> => {
    const store = await stores.get(project);
    const facts = await projectFacts(store);
    if (!facts || facts.archived || facts.repoPath === null) return undefined;
    const mark = await gateMark(store.db, store.projectId);
    const listed = await listing(project, facts.repoPath, mark);
    const tickets = await ticketLinks(store.db, store.projectId);
    return {
      project,
      name: facts.name,
      forge: listed.forge,
      requests: listed.requests.map((request) => openRequest(request, tickets)),
      error: listed.error,
      fetchedAt: new Date(listed.fetchedAt).toISOString(),
    };
  };

  return {
    read: async () => {
      const projects = await stores.list();
      const read = await Promise.all(
        projects.map((project) =>
          readProject(project).catch((err: unknown) =>
            failedProject(project, err, now()),
          ),
        ),
      );
      return read.filter((entry) => entry !== undefined);
    },
  };
};
