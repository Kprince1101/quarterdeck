import { forgeTerms, forgeWording, type ForgeTerms } from '@quarterdeck/rules';
import {
  FINISHED_AGENT_STATUSES,
  gitWorktrees,
  type AgentLifecycle,
} from '../agents/index.js';
import type { BusHost } from '../bus/index.js';
import {
  ACTIVE_TICKET_STATUSES,
  type BriefBuilder,
  type BuilderContext,
  type DependencyResolver,
  type ProjectBrief,
  type TurnAction,
} from '../driver/index.js';
import { projectBusName } from '../bus/index.js';
import { isProjectArchived, type PauseGate } from '../pause/index.js';
import { projectSite } from '../planner/rows.js';
import { servicesSection, ticketExternalRef } from '../services/index.js';
import {
  projectTurnsDir,
  projectWorktreesDir,
  type Store,
} from '../store/index.js';
import { readWaitingTickets } from './driver-notes.js';
import { baseRef, type CrewRules } from './rules.js';
import type { CrewSessionHost } from './sessions.js';
import type { RunLeg } from './voyage-run.js';
import type { OpenedLeg, VoyageLegSite } from './voyage-rows.js';

export interface CrewProject {
  project: string;
  store: Store;
  bus: BusHost;
  pause: PauseGate;
  sessions: CrewSessionHost;
  lifecycle: AgentLifecycle;
  rules: CrewRules;
}

export interface VoyageLeg extends OpenedLeg, CrewProject {
  repoPath: string;
}

export interface LegSite extends VoyageLegSite {
  crew: CrewProject;
  repoPath: string;
}

export const NO_VOYAGE_PROJECTS =
  'no open project has a repository path; set one before starting a voyage';

const bySlug = (a: { project: string }, b: { project: string }): number =>
  a.project.localeCompare(b.project);

const legSite = async (crew: CrewProject): Promise<LegSite | undefined> => {
  const { store } = crew;
  if (await isProjectArchived(store.db, store.projectId)) return undefined;
  const { repoPath } = await projectSite(store.db, store.projectId);
  if (repoPath === null) return undefined;
  return { project: crew.project, store, crew, repoPath };
};

export const voyageSites = async (
  projects: readonly CrewProject[],
): Promise<LegSite[]> => {
  const sites = await Promise.all(projects.map(legSite));
  return sites
    .filter((site): site is LegSite => site !== undefined)
    .toSorted(bySlug);
};

export const builderContext = async (
  leg: VoyageLeg,
  home: string,
  dependencies?: DependencyResolver,
): Promise<BuilderContext> => {
  const [models, rules, forge, services] = await Promise.all([
    leg.rules.load('models'),
    leg.rules.load('lifecycle'),
    leg.rules.forge(),
    leg.rules.services(),
  ]);
  const ctx: BuilderContext = {
    store: leg.store,
    lifecycle: leg.lifecycle,
    sessions: leg.sessions,
    worktrees: gitWorktrees,
    runtime: models.builder.runtime,
    repoPath: leg.repoPath,
    base: await baseRef(leg.repoPath, rules.mergeGate.base),
    terms: forgeTerms(forge),
    services,
    worktreesDir: projectWorktreesDir(leg.project, home),
    turnsDir: projectTurnsDir(leg.project, home),
    budget: rules.budget.window,
    pause: leg.pause,
    voyageId: leg.voyageId,
  };
  if (dependencies !== undefined) ctx.dependencies = dependencies;
  return ctx;
};

const holds = async (
  leg: VoyageLeg,
  table: 'tickets' | 'agents',
  id: string,
): Promise<boolean> => {
  const { rows } = await leg.store.db.query(
    `select 1 from ${table} where id = $1 and project_id = $2`,
    [id, leg.store.projectId],
  );
  return rows.length > 0;
};

const actionTarget = (
  action: TurnAction,
): { table: 'tickets' | 'agents'; id: string; noun: string } => {
  if (action.kind === 'continue')
    return { table: 'agents', id: action.builder, noun: 'builder' };
  return { table: 'tickets', id: action.ticket, noun: 'ticket' };
};

export class NotInVoyageError extends Error {
  constructor(noun: string, id: string) {
    super(`${noun} ${id} is in none of this voyage's projects`);
    this.name = 'NotInVoyageError';
  }
}

export const resolveLeg = async (
  legs: readonly VoyageLeg[],
  action: TurnAction,
  home: string,
  dependencies?: DependencyResolver,
): Promise<RunLeg> => {
  const target = actionTarget(action);
  for (const leg of legs) {
    if (await holds(leg, target.table, target.id))
      return {
        project: leg.project,
        builders: await builderContext(leg, home, dependencies),
      };
  }
  throw new NotInVoyageError(target.noun, target.id);
};

interface BuilderRow {
  id: string;
  name: string;
  status: string;
  ticketId: string | null;
  ticketTitle: string | null;
}

const toBriefBuilder = (row: BuilderRow): BriefBuilder => {
  const builder: BriefBuilder = {
    id: row.id,
    name: row.name,
    status: row.status,
    ticket: null,
  };
  if (row.ticketId !== null)
    builder.ticket = { id: row.ticketId, title: row.ticketTitle ?? '' };
  return builder;
};

const liveBuilders = async (store: Store): Promise<BriefBuilder[]> => {
  const { rows } = await store.db.query<BuilderRow>(
    `select a.id, a.name, a.status, t.id as "ticketId", t.title as "ticketTitle"
     from agents a
     left join tickets t on t.assignee_id = a.id and t.status = any($2::text[])
     where a.project_id = $1 and a.role = 'builder'
       and a.status <> all($3::text[])
     order by a.created_at, a.id`,
    [store.projectId, ACTIVE_TICKET_STATUSES, FINISHED_AGENT_STATUSES],
  );
  return rows.map(toBriefBuilder);
};

export const ticketServices = async (
  crew: Pick<CrewProject, 'store' | 'rules'>,
  ticketId: string,
): Promise<string> => {
  const { db, projectId } = crew.store;
  const [services, externalRef] = await Promise.all([
    crew.rules.services(),
    ticketExternalRef(db, projectId, ticketId),
  ]);
  return servicesSection(services, externalRef);
};

export const projectBrief = async (leg: VoyageLeg): Promise<ProjectBrief> => ({
  project: leg.project,
  repoPath: leg.repoPath,
  bus: projectBusName(leg.project),
  terms: forgeTerms(await leg.rules.forge()),
  waiting: await readWaitingTickets(leg.store),
  builders: await liveBuilders(leg.store),
  services: await leg.rules.services(),
});

export const sharedTerms = (
  briefs: readonly Pick<ProjectBrief, 'terms'>[],
): ForgeTerms | undefined => {
  const [first, ...rest] = briefs;
  if (first === undefined) return undefined;
  if (rest.some(({ terms }) => terms.name !== first.terms.name))
    return undefined;
  return first.terms;
};

export const voyageCharter = (
  charter: string,
  briefs: readonly Pick<ProjectBrief, 'terms'>[],
): string => {
  const terms = sharedTerms(briefs);
  if (terms === undefined) return charter;
  return forgeWording(charter, terms);
};
