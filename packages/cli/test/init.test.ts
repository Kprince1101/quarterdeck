import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRule } from '@quarterdeck/rules';
import {
  WORKSPACE_FILE,
  createProjectStores,
  quarterdeckHome,
  readWorkspace,
} from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, slugFromFolder, type CliIo } from '../src/index.js';
import { entries, sandbox, testIo, type Sandbox } from './harness.js';

const TIMEOUT = 30_000;
const SLUG = 'deck-repo';

const init = (args: string[], io: CliIo) => main(['init', ...args], io);

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

const repoLayer = (repo: string) =>
  join(repo, '.quarterdeck', 'rules.local.models.json');

const machineLayer = (home: string) =>
  join(quarterdeckHome(home), 'rules.local.models.json');

const runtimes = async (box: Sandbox) => {
  const models = await loadRule('models', {
    homeDir: box.home,
    repoDir: box.repo,
  });
  return [
    models.planner.runtime,
    models.driver.runtime,
    models.builder.runtime,
    models.reviewer.runtime,
  ];
};

const projectRow = async (home: string, slug: string) => {
  const stores = createProjectStores(quarterdeckHome(home));
  try {
    const store = await stores.get(slug);
    const { rows } = await store.db.query<{
      slug: string;
      name: string;
      repo_path: string;
    }>('select slug, name, repo_path from projects');
    return rows[0];
  } finally {
    await stores.closeAll();
  }
};

describe('quarterdeck init', { timeout: TIMEOUT }, () => {
  let box: Sandbox;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.close();
  });

  it('creates ~/.quarterdeck and a single-repository workspace, and writes nothing into the repo', async () => {
    const io = testIo(box.home);
    expect(await init([box.repo], io)).toBe(0);

    expect(await entries(box.repo)).toEqual(['.git']);
    expect(await entries(quarterdeckHome(box.home))).toEqual([
      SLUG,
      WORKSPACE_FILE,
    ]);
    expect(await projectRow(box.home, SLUG)).toEqual({
      slug: SLUG,
      name: 'Deck Repo',
      repo_path: box.repo,
    });
    expect(await runtimes(box)).toEqual(['kiro', 'kiro', 'kiro', 'kiro']);
    expect(io.lines).toEqual([
      `Added Deck Repo at ${box.repo}`,
      'Runtime: kiro',
      `Workspace: one repository, ${box.repo}`,
      `Data: ${join(quarterdeckHome(box.home), SLUG)}`,
      'Next: npm run quarterdeck -- up',
    ]);
    expect(io.lines.join('\n')).not.toMatch(/project/i);
    expect(await readWorkspace(quarterdeckHome(box.home))).toMatchObject({
      root: box.repo,
      mode: 'single',
      projects: [
        { slug: SLUG, name: 'Deck Repo', repoPath: box.repo, repository: null },
      ],
    });
  });

  it('takes the repo from the current directory, and --project and --name', async () => {
    const io = { ...testIo(box.home), cwd: box.repo };
    expect(await init(['--project', 'deck', '--name', 'Deck'], io)).toBe(0);
    expect(await projectRow(box.home, 'deck')).toMatchObject({
      name: 'Deck',
      repo_path: box.repo,
    });
  });

  it('with --folder saves the runtime in <repo>/.quarterdeck/ only', async () => {
    const io = testIo(box.home);
    expect(await init([box.repo, '--runtime', 'claude', '--folder'], io)).toBe(
      0,
    );

    expect(await entries(box.repo)).toEqual(['.git', '.quarterdeck']);
    expect(await entries(join(box.repo, '.quarterdeck'))).toEqual([
      'rules.local.models.json',
    ]);
    expect(await entries(quarterdeckHome(box.home))).toEqual([
      SLUG,
      WORKSPACE_FILE,
    ]);
    expect(await runtimes(box)).toEqual([
      'claude',
      'claude',
      'claude',
      'claude',
    ]);
    expect(io.lines[1]).toBe(
      `Runtime: claude, saved in ${repoLayer(box.repo)}`,
    );
  });

  it('with --no-folder saves the runtime for the machine and leaves the repo alone', async () => {
    const io = testIo(box.home);
    expect(
      await init([box.repo, '--runtime', 'gemini', '--no-folder'], io),
    ).toBe(0);

    expect(await entries(box.repo)).toEqual(['.git']);
    expect(await readJson(machineLayer(box.home))).toEqual({
      planner: { runtime: 'gemini' },
      driver: { runtime: 'gemini' },
      builder: { runtime: 'gemini' },
      reviewer: { runtime: 'gemini' },
    });
    expect(await runtimes(box)).toEqual([
      'gemini',
      'gemini',
      'gemini',
      'gemini',
    ]);
  });

  it('writes no rules file when the runtime is already the default', async () => {
    const io = testIo(box.home);
    expect(await init([box.repo, '--runtime', 'kiro', '--folder'], io)).toBe(0);
    expect(await entries(box.repo)).toEqual(['.git']);
    expect(await entries(quarterdeckHome(box.home))).toEqual([
      SLUG,
      WORKSPACE_FILE,
    ]);
  });

  it('asks before choosing between the repo and the machine when not interactive', async () => {
    const io = testIo(box.home);
    expect(await init([box.repo, '--runtime', 'claude'], io)).toBe(1);
    expect(io.errors[0]).toContain('Pass --folder');
    expect(await entries(box.repo)).toEqual(['.git']);
    expect(await entries(box.home)).toEqual([]);
  });

  it('asks for the runtime and the folder when interactive', async () => {
    const io = testIo(box.home, ['claude', 'y']);
    expect(await init([box.repo], io)).toBe(0);
    expect(io.questions).toEqual([
      'Runtime (kiro, claude, gemini) [kiro]: ',
      expect.stringContaining(
        `Save runtime claude in ${join(box.repo, '.quarterdeck')}/`,
      ),
    ]);
    expect(await runtimes(box)).toEqual([
      'claude',
      'claude',
      'claude',
      'claude',
    ]);
  });

  it('saves for the machine when the folder is declined', async () => {
    const io = testIo(box.home, ['gemini', 'n']);
    expect(await init([box.repo], io)).toBe(0);
    expect(await entries(box.repo)).toEqual(['.git']);
    expect(await runtimes(box)).toEqual([
      'gemini',
      'gemini',
      'gemini',
      'gemini',
    ]);
  });

  it('re-asks an answer it does not understand and takes the default on enter', async () => {
    const io = testIo(box.home, ['codex', '']);
    expect(await init([box.repo], io)).toBe(0);
    expect(io.questions).toHaveLength(2);
    expect(await entries(box.repo)).toEqual(['.git']);
  });

  it('keeps the other settings of an existing repo layer', async () => {
    await mkdir(join(box.repo, '.quarterdeck'));
    await writeFile(
      repoLayer(box.repo),
      JSON.stringify({ reviewer: { runtime: 'claude', model: 'opus' } }),
    );
    const io = testIo(box.home);
    expect(await init([box.repo, '--runtime', 'gemini', '--folder'], io)).toBe(
      0,
    );
    expect(await readJson(repoLayer(box.repo))).toEqual({
      planner: { runtime: 'gemini' },
      driver: { runtime: 'gemini' },
      builder: { runtime: 'gemini' },
      reviewer: { runtime: 'gemini', model: 'opus' },
    });
  });

  it('refuses --no-folder when a repo layer would override the machine', async () => {
    await mkdir(join(box.repo, '.quarterdeck'));
    await writeFile(
      repoLayer(box.repo),
      JSON.stringify({ driver: { runtime: 'claude' } }),
    );
    const io = testIo(box.home);
    expect(
      await init([box.repo, '--runtime', 'gemini', '--no-folder'], io),
    ).toBe(1);
    expect(io.errors[0]).toContain('Pass --folder to change it there');
  });

  it('names a broken rules file instead of crashing', async () => {
    await mkdir(join(box.repo, '.quarterdeck'));
    await writeFile(repoLayer(box.repo), '{ nope');
    const io = testIo(box.home);
    expect(await init([box.repo], io)).toBe(1);
    expect(io.errors[0]).toContain(repoLayer(box.repo));
    expect(await entries(box.home)).toEqual([]);
  });

  it('refuses a second project with the same slug', async () => {
    expect(await init([box.repo], testIo(box.home))).toBe(0);
    const io = testIo(box.home);
    expect(await init([box.repo], io)).toBe(1);
    expect(io.errors).toEqual([`project ${SLUG} already exists`]);
  });

  it.each([
    [['missing'], 'is not a directory'],
    [['--runtime', 'codex'], '--runtime must be one of kiro, claude, gemini'],
    [['--project', 'Not A Slug'], 'Invalid project.create: project:'],
    [['--folder', '--no-folder'], 'not both'],
    [['a', 'b'], 'init takes one path'],
    [['--color'], "Unknown option '--color'"],
  ])('fails cleanly on %j', async (args, message) => {
    const io = { ...testIo(box.home), cwd: box.repo };
    expect(await init(args, io)).toBe(1);
    expect(io.errors.join('\n')).toContain(message);
    expect(await entries(box.home)).toEqual([]);
  });

  it('refuses a directory that is neither a git repository nor holds any', async () => {
    const plain = join(box.home, 'plain');
    await mkdir(join(plain, 'notes'), { recursive: true });
    const io = testIo(box.home);
    expect(await init([plain], io)).toBe(1);
    expect(io.errors[0]).toBe(
      `${plain} is not a git repository (no .git) and holds none one level down`,
    );
  });

  it('exits 130 with nothing created when a prompt is cancelled', async () => {
    const io = testIo(box.home);
    const cancelled = {
      ...io,
      prompter: {
        ask: () =>
          Promise.reject(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
          ),
      },
    };
    expect(await init([box.repo], cancelled)).toBe(130);
    expect(io.errors).toEqual(['Cancelled.']);
    expect(await entries(box.home)).toEqual([]);
  });
});

describe(
  'quarterdeck init of a folder of repositories',
  { timeout: TIMEOUT },
  () => {
    let box: Sandbox;
    let root: string;
    const REPOS = ['retrofit-a', 'ui-extras', 'ui-kit'];

    const repoAt = (name: string) => join(root, name);

    beforeEach(async () => {
      box = await sandbox();
      root = join(box.home, '..', 'Repos');
      for (const name of REPOS) {
        await mkdir(join(repoAt(name), '.git'), { recursive: true });
      }
      await mkdir(join(root, 'notes'));
      await mkdir(join(root, '.hidden', '.git'), { recursive: true });
    });

    afterEach(async () => {
      await box.close();
    });

    const listing = () => [
      `Repositories in ${root}, each one a project:`,
      ...REPOS.map(
        (name, index) => `  ${index + 1}. ${name}  no origin  ${repoAt(name)}`,
      ),
    ];

    it('lists every repository one level down and makes each a project in multi mode', async () => {
      const io = testIo(box.home);
      expect(await init([root], io)).toBe(0);
      expect(io.lines).toEqual([
        ...listing(),
        ...REPOS.map(
          (name) => `Created project ${name} (${name}) for ${repoAt(name)}`,
        ),
        'Runtime: kiro',
        `Workspace: 3 projects in ${root}`,
        ...REPOS.map(
          (name) => `Data: ${join(quarterdeckHome(box.home), name)}`,
        ),
        'Next: npm run quarterdeck -- up',
      ]);
      const workspace = await readWorkspace(quarterdeckHome(box.home));
      expect(workspace).toMatchObject({ root, mode: 'multi' });
      expect(workspace?.projects.map((project) => project.slug)).toEqual(REPOS);
      expect(await projectRow(box.home, 'ui-kit')).toEqual({
        slug: 'ui-kit',
        name: 'ui-kit',
        repo_path: repoAt('ui-kit'),
      });
    });

    it('skips what the user unticks', async () => {
      const io = testIo(box.home, ['2', '']);
      expect(await init([root], io)).toBe(0);
      expect(io.questions[0]).toBe(
        'Untick any by number, separated by spaces (enter keeps them all): ',
      );
      const workspace = await readWorkspace(quarterdeckHome(box.home));
      expect(workspace?.projects.map((project) => project.slug)).toEqual([
        'retrofit-a',
        'ui-kit',
      ]);
      expect(await entries(quarterdeckHome(box.home))).not.toContain(
        'ui-extras',
      );
    });

    it('re-asks an untick answer it does not understand', async () => {
      const io = testIo(box.home, ['9', 'two', '1 3', '']);
      expect(await init([root], io)).toBe(0);
      const workspace = await readWorkspace(quarterdeckHome(box.home));
      expect(workspace?.projects.map((project) => project.slug)).toEqual([
        'ui-extras',
      ]);
    });

    it('leaves out --skip repositories when scripted', async () => {
      const io = testIo(box.home);
      expect(await init([root, '--skip', 'ui-kit'], io)).toBe(0);
      const workspace = await readWorkspace(quarterdeckHome(box.home));
      expect(workspace?.projects.map((project) => project.slug)).toEqual([
        'retrofit-a',
        'ui-extras',
      ]);
    });

    it('refuses --project for a folder', async () => {
      const io = testIo(box.home);
      expect(await init([root, '--project', 'one'], io)).toBe(1);
      expect(io.errors[0]).toContain(
        '--project and --name name one repository',
      );
      expect(await entries(box.home)).toEqual([]);
    });

    it('adds only new repositories when the folder is given again', async () => {
      expect(await init([root, '--skip', 'ui-kit'], testIo(box.home))).toBe(0);
      const io = testIo(box.home);
      expect(await init([root], io)).toBe(0);
      expect(io.lines).toContain(
        '  already a project: retrofit-a  ' + repoAt('retrofit-a'),
      );
      expect(io.lines).toContain(
        `Created project ui-kit (ui-kit) for ${repoAt('ui-kit')}`,
      );
      const workspace = await readWorkspace(quarterdeckHome(box.home));
      expect(workspace?.projects.map((project) => project.slug)).toEqual([
        'retrofit-a',
        'ui-extras',
        'ui-kit',
      ]);
    });

    it('switches a single-repository workspace to multi mode with a notice when a second repository is added', async () => {
      expect(await init([repoAt('ui-kit')], testIo(box.home))).toBe(0);
      expect(await readWorkspace(quarterdeckHome(box.home))).toMatchObject({
        mode: 'single',
        root: repoAt('ui-kit'),
      });
      const io = testIo(box.home);
      expect(await init([repoAt('ui-extras')], io)).toBe(0);
      expect(io.lines[0]).toBe(
        'Workspace switched to multi mode: it now has 2 repositories, and each one is a project.',
      );
      expect(io.lines[1]).toBe(
        `Created project ui-extras (ui-extras) for ${repoAt('ui-extras')}`,
      );
      const workspace = await readWorkspace(quarterdeckHome(box.home));
      expect(workspace).toMatchObject({ mode: 'multi', root });
      expect(workspace?.projects.map((project) => project.slug)).toEqual([
        'ui-kit',
        'ui-extras',
      ]);
    });
  },
);

describe('slugFromFolder', () => {
  it.each([
    ['Deck Repo', 'deck-repo'],
    ['quarterdeck', 'quarterdeck'],
    ['.dotfiles', 'dotfiles'],
    ['My_App.v2', 'my_app-v2'],
    ['x'.repeat(80), 'x'.repeat(63)],
  ])('%s becomes %s', (folder, slug) => {
    expect(slugFromFolder(folder)).toBe(slug);
  });
});
