import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { badRequest } from '../api/http-error.js';
import type { GitRunner } from '../gate/forge.js';
import {
  originRepository,
  repositoryName,
  runGit,
} from '../gate/repository.js';
import type { WorkspaceMode, WorkspaceProject } from '../stream/schema.js';

const MAX_SLUG_LENGTH = 63;

export const slugFromFolder = (folder: string): string =>
  folder
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_SLUG_LENGTH);

export interface WorkspaceDetection {
  root: string;
  mode: WorkspaceMode;
  repositories: WorkspaceProject[];
}

export interface DetectOptions {
  run?: GitRunner | undefined;
}

const isDirectory = async (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

const hasGit = (path: string): Promise<boolean> =>
  stat(join(path, '.git')).then(
    () => true,
    () => false,
  );

const originName = async (
  repoPath: string,
  run: GitRunner,
): Promise<string | null> => {
  try {
    return repositoryName(await originRepository(repoPath, run));
  } catch {
    return null;
  }
};

export const describeRepository = async (
  repoPath: string,
  { run = runGit }: DetectOptions = {},
): Promise<WorkspaceProject> => {
  const folder = basename(repoPath);
  return {
    slug: slugFromFolder(folder),
    name: folder,
    repoPath,
    repository: await originName(repoPath, run),
  };
};

const childRepositories = async (root: string): Promise<string[]> => {
  const children = await readdir(root, { withFileTypes: true });
  const folders = children
    .filter((child) => !child.name.startsWith('.'))
    .map((child) => join(root, child.name))
    .toSorted();
  const isRepo = await Promise.all(
    folders.map(async (path) => (await isDirectory(path)) && hasGit(path)),
  );
  return folders.filter((_, index) => isRepo[index]);
};

export const detectWorkspace = async (
  root: string,
  options: DetectOptions = {},
): Promise<WorkspaceDetection> => {
  if (!(await isDirectory(root))) {
    throw badRequest(`${root} is not a directory`);
  }
  if (await hasGit(root)) {
    return {
      root,
      mode: 'single',
      repositories: [await describeRepository(root, options)],
    };
  }
  const paths = await childRepositories(root);
  if (paths.length === 0) {
    throw badRequest(
      `${root} is not a git repository (no .git) and holds none one level down`,
    );
  }
  return {
    root,
    mode: 'multi',
    repositories: await Promise.all(
      paths.map((path) => describeRepository(path, options)),
    ),
  };
};

export const confirmationList = (detection: WorkspaceDetection): string[] =>
  detection.repositories.map(
    (repo, index) =>
      `  ${index + 1}. ${repo.slug}  ${repo.repository ?? 'no origin'}  ${repo.repoPath}`,
  );
