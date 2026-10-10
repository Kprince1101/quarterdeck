import { join } from 'node:path';
import { RULE_NAMES } from '@quarterdeck/rules';
import { describe, expect, it } from 'vitest';
import { dataPaths } from '../../src/data/index.js';

const HOME = '/home/me';
const DATA = join(HOME, '.quarterdeck');

describe('dataPaths', () => {
  it('names the project folders, then the repo and machine layers', () => {
    const paths = dataPaths({
      homeDir: HOME,
      project: 'deck',
      repoPath: '/work/deck',
    });
    expect(
      paths.filter((path) => path.scope === 'project').map(({ path }) => path),
    ).toEqual([
      join(DATA, 'deck', 'pg'),
      join(DATA, 'deck', 'pg.lock'),
      join(DATA, 'deck', 'turns'),
      join(DATA, 'deck', 'worktrees'),
    ]);
    const repo = paths.filter((path) => path.scope === 'repo');
    const machine = paths.filter((path) => path.scope === 'machine');
    expect(repo).toHaveLength(RULE_NAMES.length);
    expect(repo.map(({ label }) => label)).toEqual(
      machine.slice(0, RULE_NAMES.length).map(({ label }) => label),
    );
    repo.forEach(({ path, label }) =>
      expect(path).toBe(join('/work/deck', '.quarterdeck', label)),
    );
    expect(machine.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        join(DATA, 'profiles'),
        join(DATA, 'plugins'),
        join(DATA, 'pause.json'),
        join(DATA, 'sock'),
        join(DATA, 'kiro'),
        join(DATA, 'gemini'),
        join(DATA, 'runtimes', 'claude'),
      ]),
    );
  });

  it('leaves out repo rules when the project has no repo', () => {
    const paths = dataPaths({ homeDir: HOME, project: 'deck', repoPath: null });
    expect(paths.some((path) => path.scope === 'repo')).toBe(false);
  });

  it('names the database instead of a data dir on external Postgres', () => {
    const database = 'postgres://db.local:5432/quarterdeck';
    const project = dataPaths({ homeDir: HOME, project: 'deck', database })
      .filter((path) => path.scope === 'project')
      .map(({ label, path, kind }) => ({ label, path, kind }));
    expect(project).toEqual([
      { label: 'Postgres database', path: database, kind: 'database' },
      {
        label: 'Turn files',
        path: join(DATA, 'deck', 'turns'),
        kind: 'directory',
      },
      {
        label: 'Worktrees',
        path: join(DATA, 'deck', 'worktrees'),
        kind: 'directory',
      },
    ]);
  });

  it('refuses a slug that is not a project', () => {
    expect(() => dataPaths({ homeDir: HOME, project: '../etc' })).toThrow(
      'Invalid project slug',
    );
  });
});
