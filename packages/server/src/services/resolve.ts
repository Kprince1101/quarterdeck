import {
  loadRule,
  trackerSchema,
  type LoadRulesOptions,
  type ProjectServicesRule,
  type ServicesRule,
  type Tracker,
} from '@quarterdeck/rules';
import type { ServiceSource } from '../intents/index.js';
import type { Queryable, Store } from '../store/index.js';

export interface StoredServices {
  slug: string;
  repoPath: string | null;
  tracker: Tracker | null;
  publishes: boolean | null;
}

export interface ResolvedServices {
  tracker: Tracker | null;
  trackerFrom: ServiceSource;
  publishes: boolean;
  publishesFrom: ServiceSource;
}

interface StoredRow {
  slug: string;
  repoPath: string | null;
  tracker: unknown;
  publishes: boolean | null;
}

const parseTracker = (tracker: unknown): Tracker | null => {
  if (tracker === null) return null;
  return trackerSchema.parse(tracker);
};

export const readStoredServices = async (
  db: Queryable,
  projectId: string,
): Promise<StoredServices> => {
  const { rows } = await db.query<StoredRow>(
    `select slug, repo_path as "repoPath", tracker, publishes
     from projects where id = $1`,
    [projectId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`project ${projectId} not found`);
  return { ...row, tracker: parseTracker(row.tracker) };
};

const ruleFor = (rule: ServicesRule, slug: string): ProjectServicesRule => {
  if (!Object.hasOwn(rule.projects, slug)) return {};
  return rule.projects[slug] ?? {};
};

interface Picked<T> {
  value: T;
  from: ServiceSource;
}

const pick = <T>(
  stored: T | null,
  ruled: T | undefined,
  fallback: T,
): Picked<T> => {
  if (stored !== null) return { value: stored, from: 'project' };
  if (ruled !== undefined) return { value: ruled, from: 'rules' };
  return { value: fallback, from: 'default' };
};

export const resolveServices = (
  stored: StoredServices,
  rule: ServicesRule,
): ResolvedServices => {
  const ruled = ruleFor(rule, stored.slug);
  const tracker = pick<Tracker | null>(stored.tracker, ruled.tracker, null);
  const publishes = pick(stored.publishes, ruled.publishes, false);
  return {
    tracker: tracker.value,
    trackerFrom: tracker.from,
    publishes: publishes.value,
    publishesFrom: publishes.from,
  };
};

export interface ServicesOptions {
  homeDir?: string | undefined;
}

export const servicesRuleOptions = (
  repoPath: string | null,
  options: ServicesOptions,
): LoadRulesOptions => {
  const rules: LoadRulesOptions = {};
  if (options.homeDir !== undefined) rules.homeDir = options.homeDir;
  if (repoPath !== null) rules.repoDir = repoPath;
  return rules;
};

export const loadServices = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: ServicesOptions = {},
): Promise<ResolvedServices> => {
  const stored = await readStoredServices(store.db, store.projectId);
  const rule = await loadRule(
    'services',
    servicesRuleOptions(stored.repoPath, options),
  );
  return resolveServices(stored, rule);
};
