import { loadServices, type ServicesOptions } from '../services/index.js';
import type { Store } from '../store/index.js';
import type { WorkspaceMode } from '../stream/schema.js';

export const TICKET_PUBLISHED_EVENT = 'ticket.published';

export interface Published {
  package: string;
  version: string;
}

export interface Dependency {
  id: string;
  project: string | null;
  title: string | null;
  status: string | null;
  publishes: boolean;
  published: Published | null;
  satisfied: boolean;
  reason: string | null;
}

export type DependencyStore = Pick<Store, 'db' | 'projectId'>;

export interface DependencySource {
  store: DependencyStore;
  publishes: () => Promise<boolean>;
}

export type DependencyResolver = (
  ids: readonly string[],
) => Promise<Dependency[]>;

export const NO_OPEN_PROJECT = 'it is in no open project';

interface FoundRow {
  id: string;
  title: string;
  status: string;
  project: string;
  archived: boolean;
  published: unknown;
}

const findIn = async (
  store: DependencyStore,
  ids: readonly string[],
): Promise<FoundRow[]> => {
  const { rows } = await store.db.query<FoundRow>(
    `select t.id, t.title, t.status, p.slug as project,
       p.archived_at is not null as archived,
       (select e.payload from events e
        where e.project_id = t.project_id and e.ticket_id = t.id
          and e.kind = $3
        order by e.id desc limit 1) as published
     from tickets t join projects p on p.id = t.project_id
     where t.project_id = $1 and t.id = any($2::uuid[])`,
    [store.projectId, ids, TICKET_PUBLISHED_EVENT],
  );
  return rows;
};

const publishedOf = (payload: unknown): Published | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const { package: name, version } = payload as Record<string, unknown>;
  if (typeof name !== 'string' || typeof version !== 'string') return null;
  return { package: name, version };
};

const unmetReason = (
  row: FoundRow,
  publishes: boolean,
  published: Published | null,
): string | null => {
  if (row.archived) return `its project ${row.project} is archived`;
  if (row.status !== 'done') return `it is ${row.status}`;
  if (publishes && published === null)
    return 'it is merged but not published yet';
  return null;
};

const toDependency = (row: FoundRow, publishes: boolean): Dependency => {
  const published = publishedOf(row.published);
  const reason = unmetReason(row, publishes, published);
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    status: row.status,
    publishes,
    published,
    satisfied: reason === null,
    reason,
  };
};

const unknownDependency = (id: string): Dependency => ({
  id,
  project: null,
  title: null,
  status: null,
  publishes: false,
  published: null,
  satisfied: false,
  reason: NO_OPEN_PROJECT,
});

export const resolveDependencies = async (
  sources: readonly DependencySource[],
  ids: readonly string[],
): Promise<Dependency[]> => {
  const found = new Map<string, Dependency>();
  for (const source of sources) {
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length === 0) break;
    const rows = await findIn(source.store, missing);
    if (rows.length === 0) continue;
    const publishes = await source.publishes();
    for (const row of rows) found.set(row.id, toDependency(row, publishes));
  }
  return ids.map((id) => found.get(id) ?? unknownDependency(id));
};

export const dependencySources = (
  stores: readonly DependencyStore[],
  options: ServicesOptions = {},
): DependencySource[] => {
  const seen = new Set<string>();
  const sources: DependencySource[] = [];
  for (const store of stores) {
    if (seen.has(store.projectId)) continue;
    seen.add(store.projectId);
    sources.push({
      store,
      publishes: async () => (await loadServices(store, options)).publishes,
    });
  }
  return sources;
};

export const storeDependencies =
  (
    stores: () => readonly DependencyStore[],
    options: ServicesOptions = {},
  ): DependencyResolver =>
  (ids) =>
    resolveDependencies(dependencySources(stores(), options), ids);

export const unmetDependencies = (
  dependencies: readonly Dependency[],
): Dependency[] => dependencies.filter((dependency) => !dependency.satisfied);

export const dependencyLabel = (
  dependency: Dependency,
  mode: WorkspaceMode = 'multi',
): string => {
  if (dependency.project === null) return dependency.id;
  const title = dependency.title ?? '';
  if (mode === 'single') return `${dependency.id} ("${title}")`;
  return `${dependency.id} ("${title}", project ${dependency.project})`;
};

export const unmetText = (dependencies: readonly Dependency[]): string =>
  unmetDependencies(dependencies)
    .map((dependency) => `${dependencyLabel(dependency)}: ${dependency.reason}`)
    .join('; ');

export const readyText = (dependency: Dependency): string => {
  if (dependency.published === null) return 'merged';
  return `published ${dependency.published.package} ${dependency.published.version}`;
};

export interface DependencyPayload {
  ticket: string;
  project: string | null;
  title: string | null;
  package: string | null;
  version: string | null;
  reason: string | null;
}

export const dependencyPayload = (
  dependency: Dependency,
): DependencyPayload => ({
  ticket: dependency.id,
  project: dependency.project,
  title: dependency.title,
  package: dependency.published?.package ?? null,
  version: dependency.published?.version ?? null,
  reason: dependency.reason,
});
