import type { Store } from '../store/index.js';

export type ProjectStore = Pick<Store, 'db' | 'projectId' | 'publish'>;

export interface OpenProject<S extends ProjectStore = ProjectStore> {
  slug: string;
  name: string;
  repoPath: string | null;
  archived: boolean;
  store: S;
}

interface ProjectRow {
  slug: string;
  name: string;
  repoPath: string | null;
  archived: boolean;
}

const readProject = async <S extends ProjectStore>(
  store: S,
): Promise<OpenProject<S> | undefined> => {
  const { rows } = await store.db.query<ProjectRow>(
    `select slug, name, repo_path as "repoPath",
       archived_at is not null as archived
     from projects where id = $1`,
    [store.projectId],
  );
  const [row] = rows;
  if (!row) return undefined;
  return { ...row, store };
};

export const openProjects = async <S extends ProjectStore>(
  stores: readonly S[],
): Promise<OpenProject<S>[]> => {
  const unique = stores.filter(
    (store, index) =>
      stores.findIndex(({ projectId }) => projectId === store.projectId) ===
      index,
  );
  const read = await Promise.all(unique.map(readProject));
  return read
    .filter((project) => project !== undefined)
    .toSorted((a, b) => a.slug.localeCompare(b.slug));
};

export const activeProjects = async <S extends ProjectStore>(
  stores: readonly S[],
): Promise<OpenProject<S>[]> =>
  (await openProjects(stores)).filter(({ archived }) => !archived);

export const repoLine = (repoPath: string | null): string => {
  if (repoPath === null) return 'no repository path set';
  return repoPath;
};

export const projectsNote = (projects: readonly OpenProject[]): string => {
  if (projects.length === 0) return 'There is no active project.';
  return projects
    .map(
      ({ slug, name, repoPath }) =>
        `- \`${slug}\` (${name}): ${repoLine(repoPath)}`,
    )
    .join('\n');
};
