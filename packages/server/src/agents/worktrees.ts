import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface RemoveWorktreeOptions {
  force?: boolean;
}

export interface WorktreeHost {
  remove: (path: string, options?: RemoveWorktreeOptions) => Promise<void>;
}

export class WorktreeDirtyError extends Error {
  readonly path: string;
  readonly summary: string;

  constructor(path: string, summary: string) {
    super(
      `Worktree ${path} holds work that removing it would lose:\n${summary}`,
    );
    this.name = 'WorktreeDirtyError';
    this.path = path;
    this.summary = summary;
  }
}

const run = promisify(execFile);

const git = async (worktree: string, ...args: string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', worktree, ...args]);
  return stdout.trim();
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const isDetached = async (worktree: string): Promise<boolean> => {
  try {
    await git(worktree, 'symbolic-ref', '--quiet', 'HEAD');
    return false;
  } catch {
    return true;
  }
};

const unreachableCommits = async (worktree: string): Promise<string[]> => {
  if (!(await isDetached(worktree))) return [];
  const commits = await git(
    worktree,
    'rev-list',
    '--oneline',
    'HEAD',
    '--not',
    '--branches',
    '--tags',
    '--remotes',
  );
  return commits
    .split('\n')
    .filter(Boolean)
    .map((commit) => `commit not on any branch: ${commit}`);
};

const unsavedWork = async (worktree: string): Promise<string[]> => {
  const status = await git(worktree, 'status', '--porcelain');
  return [
    ...status.split('\n').filter(Boolean),
    ...(await unreachableCommits(worktree)),
  ];
};

const removeArgs = (path: string, force: boolean): string[] => {
  if (force) return ['worktree', 'remove', '--force', path];
  return ['worktree', 'remove', path];
};

export const gitWorktrees: WorktreeHost = {
  remove: async (path, options = {}) => {
    if (!(await exists(path))) return;
    const force = options.force ?? false;
    if (!force) {
      const unsaved = await unsavedWork(path);
      if (unsaved.length > 0) {
        throw new WorktreeDirtyError(path, unsaved.join('\n'));
      }
    }
    const gitDir = await git(
      path,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    await run('git', ['--git-dir', gitDir, ...removeArgs(path, force)]);
  },
};
