import { dirname, sep } from 'node:path';
import type {
  Workspace,
  WorkspaceMode,
  WorkspaceProject,
} from '../stream/schema.js';
import type { WorkspaceRecord } from './file.js';
import { switchNotice } from './wording.js';

export interface WorkspaceChange {
  record: WorkspaceRecord;
  added: WorkspaceProject[];
  switched: boolean;
  notice: string | null;
}

export interface WorkspaceAddition {
  root: string;
  mode: WorkspaceMode;
  projects: readonly WorkspaceProject[];
}

export const commonParent = (paths: readonly string[]): string => {
  const [first = [], ...rest] = paths.map((path) => dirname(path).split(sep));
  let length = 0;
  while (
    length < first.length &&
    rest.every((parts) => parts[length] === first[length])
  ) {
    length += 1;
  }
  return first.slice(0, length).join(sep) || sep;
};

const newProjects = (
  current: readonly WorkspaceProject[],
  added: readonly WorkspaceProject[],
): WorkspaceProject[] => {
  const paths = new Set(current.map((project) => project.repoPath));
  const slugs = new Set(current.map((project) => project.slug));
  return added.filter((project) => {
    if (paths.has(project.repoPath) || slugs.has(project.slug)) return false;
    paths.add(project.repoPath);
    slugs.add(project.slug);
    return true;
  });
};

const nextRoot = (
  current: Workspace,
  addition: WorkspaceAddition,
  projects: readonly WorkspaceProject[],
): string => {
  if (current.mode === 'multi') return current.root;
  if (addition.mode === 'multi') return addition.root;
  return commonParent(projects.map((project) => project.repoPath));
};

const nextMode = (
  current: Workspace,
  addition: WorkspaceAddition,
  projects: readonly WorkspaceProject[],
): WorkspaceMode => {
  if (current.mode === 'multi' || addition.mode === 'multi') return 'multi';
  if (projects.length > 1) return 'multi';
  return 'single';
};

const noticeOf = (
  switched: boolean,
  projects: readonly WorkspaceProject[],
): string | null => {
  if (!switched) return null;
  return switchNotice(projects.length);
};

export const mergeWorkspace = (
  current: Workspace | null,
  addition: WorkspaceAddition,
): WorkspaceChange => {
  const added = newProjects(current?.projects ?? [], addition.projects);
  if (current === null) {
    return {
      record: { root: addition.root, mode: addition.mode, projects: added },
      added,
      switched: false,
      notice: null,
    };
  }
  const projects = [...current.projects, ...added];
  const mode = nextMode(current, addition, projects);
  const switched = current.mode === 'single' && mode === 'multi';
  return {
    record: { root: nextRoot(current, addition, projects), mode, projects },
    added,
    switched,
    notice: noticeOf(switched, projects),
  };
};

export const withoutProjects = (
  current: Workspace,
  slugs: readonly string[],
): WorkspaceRecord => ({
  root: current.root,
  mode: current.mode,
  projects: current.projects.filter((project) => !slugs.includes(project.slug)),
});
