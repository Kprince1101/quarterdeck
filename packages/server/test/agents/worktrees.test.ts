import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeDirtyError, gitWorktrees } from '../../src/agents/index.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=quarterdeck',
      '-c',
      'user.email=quarterdeck@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );

const removalError = (path: string): Promise<unknown> =>
  gitWorktrees.remove(path).then(
    () => undefined,
    (err: unknown) => err,
  );

describe('gitWorktrees', () => {
  let root = '';
  let repo = '';
  let worktree = '';

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qd-worktrees-')));
    repo = join(root, 'repo');
    worktree = join(root, 'crane-1234');
    git(root, 'init', '--quiet', repo);
    git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const registered = () => git(repo, 'worktree', 'list', '--porcelain');

  it('removes a clean worktree and unregisters it', async () => {
    git(repo, 'worktree', 'add', '--quiet', '-b', 'crane/qd5a', worktree);
    git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'done');

    await gitWorktrees.remove(worktree);

    expect(existsSync(worktree)).toBe(false);
    expect(registered()).not.toContain(worktree);
    expect(git(repo, 'branch', '--list', 'crane/qd5a')).toContain('crane/qd5a');
  });

  it('refuses a worktree with uncommitted files and leaves it on disk', async () => {
    git(repo, 'worktree', 'add', '--quiet', '-b', 'crane/qd5a', worktree);
    writeFileSync(join(worktree, 'dirty.txt'), 'wip');

    const err = await removalError(worktree);

    expect(err).toBeInstanceOf(WorktreeDirtyError);
    expect(err).toMatchObject({ path: worktree, summary: '?? dirty.txt' });
    expect(existsSync(join(worktree, 'dirty.txt'))).toBe(true);
    expect(registered()).toContain(worktree);
  });

  it('refuses a detached worktree holding commits on no branch', async () => {
    git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);
    git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'wip');

    const err = await removalError(worktree);

    expect(err).toBeInstanceOf(WorktreeDirtyError);
    expect((err as WorktreeDirtyError).summary).toMatch(
      /^commit not on any branch: [0-9a-f]+ wip$/,
    );
    expect(existsSync(worktree)).toBe(true);
  });

  it('removes a detached worktree whose commits are all on a branch', async () => {
    git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);

    await gitWorktrees.remove(worktree);

    expect(existsSync(worktree)).toBe(false);
  });

  it('discards unsaved work when forced', async () => {
    git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);
    git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'wip');
    writeFileSync(join(worktree, 'dirty.txt'), 'wip');

    await gitWorktrees.remove(worktree, { force: true });

    expect(existsSync(worktree)).toBe(false);
    expect(registered()).not.toContain(worktree);
  });

  it('does nothing when the worktree is already gone', async () => {
    await expect(
      gitWorktrees.remove(join(root, 'missing')),
    ).resolves.toBeUndefined();
  });

  it('refuses to remove the main working tree', async () => {
    await expect(gitWorktrees.remove(repo, { force: true })).rejects.toThrow();
    expect(existsSync(repo)).toBe(true);
  });
});
