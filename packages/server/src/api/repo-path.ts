import { stat } from 'node:fs/promises';
import type { Queryable } from '../store/index.js';
import { hasErrorCode } from '../lib/errors.js';
import { badRequest, conflict } from './http-error.js';
import { findRow } from './record.js';

export const requireRepoPath = async (
  tx: Queryable,
  projectId: string,
): Promise<string> => {
  const project = await findRow<{ slug: string; repo_path: string | null }>(
    tx,
    'select slug, repo_path from projects where id = $1',
    [projectId],
    `project ${projectId} not found`,
  );
  if (project.repo_path === null) {
    throw conflict(`project ${project.slug} has no repoPath`);
  }
  return project.repo_path;
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
};

export const assertDirectory = async (
  path: string | null | undefined,
): Promise<void> => {
  if (typeof path !== 'string') return;
  if (!(await isDirectory(path))) {
    throw badRequest(`repoPath ${path} is not a directory`);
  }
};
