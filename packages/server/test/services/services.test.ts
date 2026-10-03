import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tracker } from '@quarterdeck/rules';
import {
  promptServices,
  resolveServices,
  servicesSection,
  type StoredServices,
} from '../../src/services/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

const exec = promisify(execFile);

const MCP_TRACKER: Tracker = {
  kind: 'tracker-mcp',
  how: 'mcp',
  server: 'tracker-mcp',
  notes: 'tickets are stories in the Example board',
};

const CLI_TRACKER: Tracker = {
  kind: 'tracker-cli',
  how: 'cli',
  command: 'tracker',
};

const stored = (overrides: Partial<StoredServices> = {}): StoredServices => ({
  slug: 'example',
  repoPath: null,
  tracker: null,
  publishes: null,
  ...overrides,
});

describe('resolveServices', () => {
  it('prefers the stored value, then the rules entry, then the default', () => {
    const rule = {
      projects: { example: { tracker: CLI_TRACKER, publishes: true } },
    };

    expect(resolveServices(stored(), { projects: {} })).toEqual({
      tracker: null,
      trackerFrom: 'default',
      publishes: false,
      publishesFrom: 'default',
    });
    expect(resolveServices(stored(), rule)).toEqual({
      tracker: CLI_TRACKER,
      trackerFrom: 'rules',
      publishes: true,
      publishesFrom: 'rules',
    });
    expect(
      resolveServices(stored({ tracker: MCP_TRACKER, publishes: false }), rule),
    ).toEqual({
      tracker: MCP_TRACKER,
      trackerFrom: 'project',
      publishes: false,
      publishesFrom: 'project',
    });
  });

  it('reads only the entry for its own project', () => {
    const rule = { projects: { sample: { tracker: CLI_TRACKER } } };

    expect(resolveServices(stored(), rule).tracker).toBeNull();
    expect(
      resolveServices(stored({ slug: 'constructor' }), rule).tracker,
    ).toBeNull();
  });
});

describe('servicesSection', () => {
  const github = { forge: 'github', host: 'github.com' } as const;

  it('names the forge, its CLI, an MCP tracker and the ticket ref', () => {
    expect(
      servicesSection({ forge: github, tracker: MCP_TRACKER }, 'EX-42'),
    ).toBe(
      [
        '## Services',
        '- Forge: GitHub at github.com. Use the `gh` CLI for pull requests, reviews and checks.',
        '- Tracker: tracker-mcp, reached through the `tracker-mcp` MCP server. Notes: tickets are stories in the Example board',
        '- This ticket in the tracker: EX-42',
        'Use these tools yourself. Quarterdeck never calls the tracker for you.',
      ].join('\n'),
    );
  });

  it('speaks GitLab terms and names a CLI tracker', () => {
    const section = servicesSection({
      forge: { forge: 'gitlab', host: 'git.example.org' },
      tracker: CLI_TRACKER,
    });

    expect(section).toContain(
      '- Forge: GitLab at git.example.org. Use the `glab` CLI for merge requests, reviews and checks.',
    );
    expect(section).toContain(
      '- Tracker: tracker-cli, reached with the `tracker` CLI.',
    );
    expect(section).not.toContain('This ticket in the tracker');
  });

  it('says there is no tracker when none is set or it is none', () => {
    const none = servicesSection({
      forge: { forge: 'github', host: null },
      tracker: { kind: 'none' },
    });

    expect(none).toContain('- Forge: GitHub. Use the `gh` CLI');
    expect(none).toContain('- Tracker: none.');
    expect(servicesSection({ forge: github, tracker: null })).toContain(
      '- Tracker: none.',
    );
  });
});

describe('promptServices', () => {
  let homeDir = '';
  let repoDir = '';
  let store: Store;

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-services-home-'));
    repoDir = await mkdtemp(join(tmpdir(), 'qd-services-repo-'));
    await exec('git', ['init', '-q', repoDir]);
    await exec('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'https://gitlab.com/example-org/sample.git',
    ]);
    await mkdir(join(homeDir, '.quarterdeck'));
    await writeFile(
      join(homeDir, '.quarterdeck', 'rules.local.services.json'),
      JSON.stringify({ projects: { sample: { tracker: CLI_TRACKER } } }),
    );
    store = await openStore({ project: 'sample', dataDir: IN_MEMORY });
    await store.db.query('update projects set repo_path = $2 where id = $1', [
      store.projectId,
      repoDir,
    ]);
  });

  afterAll(async () => {
    await store.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('joins the detected forge with the resolved tracker', async () => {
    expect(await promptServices(store, { homeDir })).toEqual({
      forge: { forge: 'gitlab', host: 'gitlab.com' },
      tracker: CLI_TRACKER,
    });

    await store.db.query(
      'update projects set tracker = $2::jsonb where id = $1',
      [store.projectId, JSON.stringify(MCP_TRACKER)],
    );

    expect((await promptServices(store, { homeDir })).tracker).toEqual(
      MCP_TRACKER,
    );
  });
});
