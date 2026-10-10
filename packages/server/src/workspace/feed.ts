import { pathExists } from '../lib/fs.js';
import type { Workspace, WorkspaceMode } from '../stream/schema.js';
import {
  readWorkspace,
  workspacePath,
  writeWorkspace,
  type WorkspaceRecord,
} from './file.js';
import {
  commonParent,
  mergeWorkspace,
  withoutProjects,
  type WorkspaceAddition,
  type WorkspaceChange,
} from './merge.js';
import { DEFAULT_WORKSPACE_MODE } from './wording.js';

export type WorkspaceListener = (workspace: Workspace) => void;

export interface WorkspaceSeedProject {
  slug: string;
  name: string;
  repoPath: string | null;
}

export interface WorkspaceUpdate extends WorkspaceChange {
  workspace: Workspace;
}

export interface Workspaces {
  read: () => Promise<Workspace | null>;
  mode: () => Promise<WorkspaceMode>;
  seed: (
    projects: readonly WorkspaceSeedProject[],
  ) => Promise<Workspace | null>;
  add: (addition: WorkspaceAddition) => Promise<WorkspaceUpdate>;
  remove: (slugs: readonly string[]) => Promise<Workspace | null>;
  subscribe: (listener: WorkspaceListener) => () => void;
}

export { DEFAULT_WORKSPACE_MODE };

export const workspaceMode = (workspace: Workspace | null): WorkspaceMode =>
  workspace?.mode ?? DEFAULT_WORKSPACE_MODE;

const seedRecord = (
  projects: readonly WorkspaceSeedProject[],
): WorkspaceRecord | null => {
  const repos = projects.flatMap(({ slug, name, repoPath }) => {
    if (repoPath === null) return [];
    return [{ slug, name, repoPath, repository: null }];
  });
  const [only, ...others] = repos;
  if (only === undefined) return null;
  if (others.length === 0) {
    return { root: only.repoPath, mode: 'single', projects: repos };
  }
  const root = commonParent(repos.map((repo) => repo.repoPath));
  return { root, mode: 'multi', projects: repos };
};

export const createWorkspaces = (home: string): Workspaces => {
  const listeners = new Set<WorkspaceListener>();
  let loaded: Promise<Workspace | null> | undefined;
  let writing: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = writing.then(work);
    writing = done.catch(() => undefined);
    return done;
  };

  const read = (): Promise<Workspace | null> => {
    loaded ??= readWorkspace(home);
    return loaded;
  };

  const write = async (record: WorkspaceRecord): Promise<Workspace> => {
    const workspace = await writeWorkspace(home, record);
    loaded = Promise.resolve(workspace);
    listeners.forEach((listener) => listener(workspace));
    return workspace;
  };

  const seedFrom = async (
    projects: readonly WorkspaceSeedProject[],
  ): Promise<Workspace | null> => {
    if (await pathExists(workspacePath(home))) return read();
    const record = seedRecord(projects);
    if (record === null) return null;
    return write(record);
  };

  const addTo = async (
    addition: WorkspaceAddition,
  ): Promise<WorkspaceUpdate> => {
    const change = mergeWorkspace(await readWorkspace(home), addition);
    return { ...change, workspace: await write(change.record) };
  };

  const removeFrom = async (
    slugs: readonly string[],
  ): Promise<Workspace | null> => {
    const current = await readWorkspace(home);
    if (current === null) return null;
    if (!current.projects.some((project) => slugs.includes(project.slug))) {
      return current;
    }
    return write(withoutProjects(current, slugs));
  };

  return {
    read,
    mode: async () => workspaceMode(await read()),
    seed: (projects) => inTurn(() => seedFrom(projects)),
    add: (addition) => inTurn(() => addTo(addition)),
    remove: (slugs) => inTurn(() => removeFrom(slugs)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
