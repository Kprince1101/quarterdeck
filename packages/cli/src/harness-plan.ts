import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { slugFromFolder } from '@quarterdeck/server';
import { projectSlugSchema } from '@quarterdeck/server/intents';
import type {
  HarnessItem,
  HarnessNote,
  HarnessProject,
  HarnessSnapshot,
} from './harness-read.js';

export const HARNESS_SOURCE = 'harness';

const DEPRECATED_AI_REVIEW_KEY = 'requireCopilotReview';

const WRITABLE_STATUSES = new Set(['proposed', 'open', 'blocked']);

const IN_FLIGHT = new Set(['in_progress', 'in_review', 'assigned', 'bounced']);

const OPEN_STATUSES = new Set(['open', 'approved', 'pending']);

export interface ExistingProject {
  slug: string;
  name: string;
  repoPath: string | null;
}

export interface ExistingTicket {
  project: string;
  id: string;
  title: string;
  body: string;
  status: string;
  dependsOn: string[];
  prUrl: string | null;
}

export interface ExistingNote {
  id: string;
  body: string;
  pinned: boolean;
  retired: boolean;
}

export interface ExistingGlobalNote extends ExistingNote {
  project: string;
}

export interface QuarterdeckState {
  projects: ExistingProject[];
  tickets: ReadonlyMap<string, ExistingTicket>;
  notes: ReadonlyMap<string, ExistingNote>;
  globalNotes: ReadonlyMap<string, ExistingGlobalNote>;
  lifecyclePath: string;
  lifecycleLayer: Record<string, unknown>;
}

export interface PlanOptions {
  homeDir: string;
  includeArchived: boolean;
  isDirectory: (path: string) => Promise<boolean>;
}

export type RowAction = 'create' | 'update' | 'unchanged' | 'kept';

export interface TicketPlan {
  harnessId: string;
  project: string;
  id: string;
  title: string;
  body: string;
  status: string;
  dependsOn: string[];
  prUrl: string | null;
  action: RowAction;
  decisions: string[];
}

export interface NotePlan {
  harnessId: string;
  project: string;
  id: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  global: boolean;
  action: RowAction;
  decisions: string[];
}

export interface ProjectPlan {
  harness: HarnessProject;
  slug: string;
  created: boolean;
  repoPath: string | null;
  decisions: string[];
  tickets: TicketPlan[];
  notes: NotePlan[];
}

export interface RulesPlan {
  path: string;
  requireAiReview: boolean;
  autoMerge: boolean;
  layer: Record<string, unknown>;
  change: boolean;
  decisions: string[];
}

export interface ImportPlan {
  projects: ProjectPlan[];
  globalNotes: NotePlan[];
  skipped: string[];
  reviewers: string[];
  rules: RulesPlan | null;
}

interface TicketTarget {
  id: string;
  project: string;
  title: string;
}

export const noteKey = (project: string, harnessId: string): string =>
  `${project}\u0000${harnessId}`;

const quoted = (value: string): string => JSON.stringify(value);

const listOf = (items: readonly string[]): string => items.join(', ');

const expandHome = (path: string, homeDir: string): string => {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const findExisting = (
  harness: HarnessProject,
  slug: string,
  repoPath: string | undefined,
  existing: readonly ExistingProject[],
): { project: ExistingProject; by: string } | undefined => {
  const byName = existing.find((project) => project.name === harness.name);
  if (byName) return { project: byName, by: 'name' };
  const bySlug = existing.find((project) => project.slug === slug);
  if (bySlug) return { project: bySlug, by: 'slug' };
  const byRepo = existing.find(
    (project) => repoPath !== undefined && project.repoPath === repoPath,
  );
  if (byRepo) return { project: byRepo, by: 'repository' };
  return undefined;
};

const newRepoPath = async (
  repos: readonly string[],
  options: PlanOptions,
  decisions: string[],
): Promise<string | null> => {
  const [first] = repos;
  if (first === undefined) {
    decisions.push('no repository in Harness; created without one');
    return null;
  }
  if (isAbsolute(first) && (await options.isDirectory(first))) return first;
  decisions.push(
    `repository ${first} is not a folder on this machine; created without one`,
  );
  return null;
};

const planProject = async (
  harness: HarnessProject,
  state: QuarterdeckState,
  planned: readonly ProjectPlan[],
  options: PlanOptions,
): Promise<ProjectPlan | string> => {
  const repos = harness.repos.map((repo) => expandHome(repo, options.homeDir));
  const slug = slugFromFolder(harness.name);
  const match = findExisting(harness, slug, repos[0], state.projects);
  const decisions: string[] = [];
  const extra = repos.slice(1);
  if (extra.length > 0)
    decisions.push(
      `also in Harness, not imported: ${listOf(extra)} (a Quarterdeck project has one repository)`,
    );
  const base = { harness, decisions, tickets: [], notes: [] };
  if (match) {
    decisions.unshift(`matches the existing project by ${match.by}`);
    return {
      ...base,
      slug: match.project.slug,
      created: false,
      repoPath: match.project.repoPath,
    };
  }
  if (!projectSlugSchema.safeParse(slug).success)
    return `Skipped project ${quoted(harness.name)}: it gives no usable project slug.`;
  if (planned.some((project) => project.slug === slug))
    return `Skipped project ${quoted(harness.name)}: its slug ${slug} is taken by another Harness project.`;
  const repoPath = await newRepoPath(repos, options, decisions);
  if (harness.paused) decisions.push('paused in Harness; created paused');
  return { ...base, slug, created: true, repoPath };
};

const priorityLine = (item: HarnessItem): string[] => {
  if (item.priority === null || item.priority === 'normal') return [];
  return [`Priority in Harness: ${item.priority}.`];
};

const prLine = (item: HarnessItem): string[] => {
  if (item.prUrl === null) return [];
  if (item.prState === null) return [`Pull request: ${item.prUrl}`];
  return [`Pull request: ${item.prUrl} (${item.prState})`];
};

const flightLines = (item: HarnessItem): string[] => {
  const lines: string[] = [];
  if (IN_FLIGHT.has(item.status))
    lines.push(
      `In flight in Harness (${item.status}) when it was imported; no agent was carried over.`,
    );
  return [...lines, ...prLine(item)];
};

const parentLine = (
  item: HarnessItem,
  targets: ReadonlyMap<string, TicketTarget>,
): string[] => {
  if (item.parentId === null) return [];
  const parent = targets.get(item.parentId);
  if (parent === undefined)
    return [`Parent in Harness: item ${item.parentId}, not imported.`];
  return [`Parent ticket: ${parent.id} (${quoted(parent.title)}).`];
};

const contextLines = (context: unknown): string[] => {
  if (context === null) return [];
  if (isObject(context) && Object.keys(context).length === 0) return [];
  if (Array.isArray(context) && context.length === 0) return [];
  return [
    'Context from Harness:',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
  ];
};

const ticketBody = (
  item: HarnessItem,
  targets: ReadonlyMap<string, TicketTarget>,
): string => {
  const footer = [
    `Imported from Harness, item ${item.id}.`,
    ...priorityLine(item),
    ...flightLines(item),
    ...parentLine(item, targets),
    ...contextLines(item.context),
  ].join('\n');
  if (item.description === '') return footer;
  return `${item.description}\n\n---\n${footer}`;
};

const statusOf = (status: string): string => {
  if (status === 'proposed' || status === 'blocked') return status;
  return 'open';
};

const statusDecision = (status: string): string => {
  const mapped = statusOf(status);
  if (IN_FLIGHT.has(status))
    return `${status} -> ${mapped} (in flight in Harness; noted in the description)`;
  if (status !== mapped && !OPEN_STATUSES.has(status))
    return `${status} -> ${mapped} (not a status Quarterdeck knows)`;
  return `${status} -> ${mapped}`;
};

const dependencies = (
  item: HarnessItem,
  targets: ReadonlyMap<string, TicketTarget>,
  decisions: string[],
): string[] => {
  const ids: string[] = [];
  for (const harnessId of item.dependsOn) {
    const target = targets.get(harnessId);
    if (target === undefined) {
      decisions.push(
        `dependency on item ${harnessId} dropped: not imported (completed, or in a skipped project)`,
      );
    } else {
      ids.push(target.id);
    }
  }
  if (ids.length === 1) decisions.push('1 dependency remapped');
  if (ids.length > 1) decisions.push(`${ids.length} dependencies remapped`);
  return ids;
};

const changeOf = (same: boolean): RowAction => {
  if (same) return 'unchanged';
  return 'update';
};

const rowAction = (
  existing: ExistingTicket | undefined,
  next: Omit<ExistingTicket, 'id' | 'project'>,
  decisions: string[],
): RowAction => {
  if (existing === undefined) return 'create';
  if (!WRITABLE_STATUSES.has(existing.status)) {
    decisions.push(`left as it is: ${existing.status} in Quarterdeck`);
    return 'kept';
  }
  return changeOf(
    existing.title === next.title &&
      existing.body === next.body &&
      existing.status === next.status &&
      existing.prUrl === next.prUrl &&
      sameList(existing.dependsOn, next.dependsOn),
  );
};

const planTicket = (
  item: HarnessItem,
  target: TicketTarget,
  state: QuarterdeckState,
  targets: ReadonlyMap<string, TicketTarget>,
): TicketPlan => {
  const decisions = [statusDecision(item.status)];
  const next = {
    title: item.title,
    body: ticketBody(item, targets),
    status: statusOf(item.status),
    dependsOn: dependencies(item, targets, decisions),
    prUrl: item.prUrl,
  };
  const existing = state.tickets.get(item.id);
  return {
    ...next,
    harnessId: item.id,
    project: target.project,
    id: target.id,
    action: rowAction(existing, next, decisions),
    decisions,
  };
};

const planNote = (
  note: HarnessNote,
  project: string,
  existing: ExistingNote | undefined,
  global: boolean,
): NotePlan => {
  const decisions: string[] = [];
  if (note.pinned) decisions.push('pinned');
  const plan = {
    harnessId: note.id,
    project,
    body: note.text,
    pinned: note.pinned,
    createdAt: note.createdAt,
    global,
    decisions,
  };
  if (existing === undefined)
    return { ...plan, id: randomUUID(), action: 'create' };
  if (existing.retired) {
    decisions.push('left as it is: retired in Quarterdeck');
    return { ...plan, id: existing.id, action: 'kept' };
  }
  const same = existing.body === note.text && existing.pinned === note.pinned;
  return { ...plan, id: existing.id, action: changeOf(same) };
};

const planProjects = async (
  snapshot: HarnessSnapshot,
  state: QuarterdeckState,
  options: PlanOptions,
  skipped: string[],
): Promise<ProjectPlan[]> => {
  const plans: ProjectPlan[] = [];
  for (const harness of snapshot.projects) {
    if (harness.archived && !options.includeArchived) {
      skipped.push(
        `Skipped project ${quoted(harness.name)}: archived in Harness (pass --include-archived to import it).`,
      );
      continue;
    }
    const plan = await planProject(harness, state, plans, options);
    if (typeof plan === 'string') skipped.push(plan);
    else plans.push(plan);
  }
  return plans;
};

const ticketTargets = (
  items: readonly HarnessItem[],
  byName: ReadonlyMap<string, ProjectPlan>,
  state: QuarterdeckState,
): Map<string, TicketTarget> => {
  const targets = new Map<string, TicketTarget>();
  for (const item of items) {
    const plan = byName.get(item.project);
    if (plan === undefined) continue;
    const existing = state.tickets.get(item.id);
    targets.set(item.id, {
      id: existing?.id ?? randomUUID(),
      project: existing?.project ?? plan.slug,
      title: item.title,
    });
  }
  return targets;
};

const addTickets = (
  snapshot: HarnessSnapshot,
  byName: ReadonlyMap<string, ProjectPlan>,
  state: QuarterdeckState,
  skipped: string[],
): void => {
  const targets = ticketTargets(snapshot.items, byName, state);
  for (const item of snapshot.items) {
    const plan = byName.get(item.project);
    const target = targets.get(item.id);
    if (plan === undefined || target === undefined) {
      skipped.push(
        `Skipped item ${item.id} ${quoted(item.title)}: its project ${quoted(item.project)} is not imported.`,
      );
      continue;
    }
    plan.tickets.push(planTicket(item, target, state, targets));
  }
};

const planGlobalNote = (
  note: HarnessNote,
  home: string | undefined,
  state: QuarterdeckState,
): NotePlan | string => {
  const existing = state.globalNotes.get(note.id);
  const project = existing?.project ?? home;
  if (project === undefined)
    return `Skipped global notebook entry ${note.id}: no project is imported to hold it.`;
  return planNote(note, project, existing, true);
};

const addNotes = (
  snapshot: HarnessSnapshot,
  plans: readonly ProjectPlan[],
  state: QuarterdeckState,
  skipped: string[],
): NotePlan[] => {
  const [home] = plans.map((plan) => plan.slug).toSorted();
  const globalNotes: NotePlan[] = [];
  for (const note of snapshot.notes) {
    if (note.project === null) {
      const plan = planGlobalNote(note, home, state);
      if (typeof plan === 'string') skipped.push(plan);
      else globalNotes.push(plan);
      continue;
    }
    const plan = plans.find(
      (candidate) => candidate.harness.id === note.project,
    );
    if (plan === undefined) {
      skipped.push(
        `Skipped notebook entry ${note.id}: its project is not imported.`,
      );
      continue;
    }
    const existing = state.notes.get(noteKey(plan.slug, note.id));
    plan.notes.push(planNote(note, plan.slug, existing, false));
  }
  return globalNotes;
};

const reviewerLines = (plans: readonly ProjectPlan[]): string[] => {
  const reviewers = new Map<string, string[]>();
  for (const plan of plans) {
    const { reviewer } = plan.harness;
    if (reviewer === null) continue;
    reviewers.set(reviewer, [...(reviewers.get(reviewer) ?? []), plan.slug]);
  }
  return [...reviewers].map(
    ([reviewer, slugs]) =>
      `Reviewer in Harness for ${listOf(slugs)}: ${reviewer}. Reviewers are not imported as agents; set up the global reviewer yourself.`,
  );
};

const flagSources = (
  plans: readonly ProjectPlan[],
  on: (project: HarnessProject) => boolean,
): { on: string[]; off: string[] } => ({
  on: plans.filter((plan) => on(plan.harness)).map((plan) => plan.slug),
  off: plans.filter((plan) => !on(plan.harness)).map((plan) => plan.slug),
});

const flagDecision = (
  key: string,
  value: boolean,
  column: string,
  sources: { on: string[]; off: string[] },
): string => {
  if (value)
    return `mergeGate.${key} true (${column} on in ${listOf(sources.on)})`;
  return `mergeGate.${key} false (${column} off in ${listOf(sources.off)})`;
};

const gateOf = (layer: Record<string, unknown>): Record<string, unknown> => {
  const gate = layer['mergeGate'];
  if (isObject(gate)) return gate;
  return {};
};

const planRules = (
  plans: readonly ProjectPlan[],
  state: QuarterdeckState,
): RulesPlan | null => {
  if (plans.length === 0) return null;
  const review = flagSources(plans, (project) => project.copilotReview);
  const merge = flagSources(plans, (project) => project.autoMerge);
  const requireAiReview = review.on.length > 0;
  const autoMerge = merge.off.length === 0;
  const gate = gateOf(state.lifecycleLayer);
  const { [DEPRECATED_AI_REVIEW_KEY]: deprecated, ...kept } = gate;
  const change =
    deprecated !== undefined ||
    gate['requireAiReview'] !== requireAiReview ||
    gate['autoMerge'] !== autoMerge;
  return {
    path: state.lifecyclePath,
    requireAiReview,
    autoMerge,
    layer: {
      ...state.lifecycleLayer,
      mergeGate: { ...kept, requireAiReview, autoMerge },
    },
    change,
    decisions: [
      flagDecision(
        'requireAiReview',
        requireAiReview,
        'copilot_review',
        review,
      ),
      flagDecision('autoMerge', autoMerge, 'auto_merge', merge),
    ],
  };
};

export const planImport = async (
  snapshot: HarnessSnapshot,
  state: QuarterdeckState,
  options: PlanOptions,
): Promise<ImportPlan> => {
  const skipped: string[] = [];
  const projects = await planProjects(snapshot, state, options, skipped);
  const byName = new Map(projects.map((plan) => [plan.harness.name, plan]));
  addTickets(snapshot, byName, state, skipped);
  const globalNotes = addNotes(snapshot, projects, state, skipped);
  return {
    projects,
    globalNotes,
    skipped,
    reviewers: reviewerLines(projects),
    rules: planRules(projects, state),
  };
};
