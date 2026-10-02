import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertProjectSlug,
  projectDataDir,
  projectTurnsDir,
  projectWorktreesDir,
  quarterdeckHome,
} from '../../src/store/index.js';

describe('store paths', () => {
  it('keeps one Postgres data dir per project under ~/.quarterdeck', () => {
    expect(quarterdeckHome()).toBe(join(homedir(), '.quarterdeck'));
    expect(projectDataDir('example')).toBe(
      join(homedir(), '.quarterdeck', 'example', 'pg'),
    );
  });

  it('roots the data dir at a custom home', () => {
    expect(projectDataDir('qd-2', '/tmp/qd')).toBe('/tmp/qd/qd-2/pg');
  });

  it('keeps turn files next to the data dir', () => {
    expect(projectTurnsDir('example')).toBe(
      join(homedir(), '.quarterdeck', 'example', 'turns'),
    );
    expect(projectTurnsDir('qd-2', '/tmp/qd')).toBe('/tmp/qd/qd-2/turns');
    expect(() => projectTurnsDir('../escape')).toThrow('Invalid project slug');
  });

  it('keeps builder worktrees next to the data dir', () => {
    expect(projectWorktreesDir('example')).toBe(
      join(homedir(), '.quarterdeck', 'example', 'worktrees'),
    );
    expect(projectWorktreesDir('qd-2', '/tmp/qd')).toBe(
      '/tmp/qd/qd-2/worktrees',
    );
    expect(() => projectWorktreesDir('../escape')).toThrow(
      'Invalid project slug',
    );
  });

  it.each(['', '../escape', 'a/b', 'Upper', '-lead', 'x'.repeat(64)])(
    'rejects the project slug %j',
    (slug) => {
      expect(() => assertProjectSlug(slug)).toThrow('Invalid project slug');
    },
  );
});
