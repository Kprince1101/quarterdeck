import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES_DIR, RULE_NAMES } from '@quarterdeck/rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rulesUrl, rulesViewSchema } from '../../src/intents/index.js';
import { TIMEOUT, bearer, startTestApi, type TestApi } from './harness.js';

const LOCAL = '.quarterdeck';

describe('GET /api/rules', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let repoDir = '';

  const read = async (
    project: string | null,
    { headers, ...init }: RequestInit = {},
  ) => {
    const res = await fetch(`${t.api.url}${rulesUrl(project)}`, {
      ...init,
      headers: {
        ...bearer(t.api.token),
        ...(headers as Record<string, string> | undefined),
      },
    });
    return { status: res.status, body: (await res.json()) as unknown, res };
  };

  const view = async (project: string | null) => {
    const { status, body } = await read(project);
    expect(status).toBe(200);
    return rulesViewSchema.parse(body);
  };

  const rule = async (project: string | null, name: string) => {
    const found = (await view(project)).rules.find((r) => r.name === name);
    if (found === undefined) throw new Error(`no ${name} in the view`);
    return found;
  };

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'qd-repo-'));
    t = await startTestApi();
    await t.send('project.create', { project: 'deck', repoPath: repoDir });
    await t.send('project.create', { project: 'bare' });
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('lists every rule with its shipped defaults and no machine layer yet', async () => {
    const machine = await view(null);
    expect(machine.project).toBeNull();
    expect(machine.repoPath).toBeNull();
    expect(machine.rules.map((r) => r.name)).toEqual(RULE_NAMES);
    const lifecycle = machine.rules.find((r) => r.name === 'lifecycle');
    expect(lifecycle).toEqual({
      name: 'lifecycle',
      file: 'lifecycle.json',
      defaults: {
        path: join(DEFAULT_RULES_DIR, 'lifecycle.json'),
        content: await readFile(
          join(DEFAULT_RULES_DIR, 'lifecycle.json'),
          'utf8',
        ),
      },
      machine: {
        path: join(t.homeDir, LOCAL, 'rules.local.lifecycle.json'),
        content: null,
      },
      repo: null,
    });
  });

  it('shows what rules.write wrote to the machine layer', async () => {
    const content = '{ "stuckAfterMinutes": 45 }\n';
    await t.send('rules.write', {
      scope: 'machine',
      name: 'lifecycle',
      content,
    });
    expect((await rule(null, 'lifecycle')).machine.content).toBe(content);
  });

  it('adds the repo layer for a project with a repo', async () => {
    await mkdir(join(repoDir, LOCAL), { recursive: true });
    const path = join(repoDir, LOCAL, 'rules.local.permissions.json');
    await writeFile(path, '{ "default": "deny" }');
    const deck = await view('deck');
    expect(deck.project).toBe('deck');
    expect(deck.repoPath).toBe(repoDir);
    const permissions = deck.rules.find((r) => r.name === 'permissions');
    expect(permissions?.repo).toEqual({
      path,
      content: '{ "default": "deny" }',
    });
    expect((await rule('deck', 'naming')).repo).toEqual({
      path: join(repoDir, LOCAL, 'rules.local.naming.json'),
      content: null,
    });
  });

  it('has no repo layer for a project without a repo', async () => {
    const bare = await view('bare');
    expect(bare.repoPath).toBeNull();
    expect(bare.rules.every((r) => r.repo === null)).toBe(true);
  });

  it('refuses an unknown project, a bad slug and anything but GET', async () => {
    expect((await read('nope')).status).toBe(404);
    expect((await read('Not A Slug')).status).toBe(400);
    const post = await read(null, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(405);
    expect(post.res.headers.get('allow')).toBe('GET');
  });

  it('lists the profiles, the files each reads and the steering files a person may edit', async () => {
    const machine = await view(null);
    expect(machine.profiles).toMatchObject({
      active: 'default',
      chosenBy: 'shipped',
      error: null,
    });
    expect(machine.profiles.profiles).toEqual([
      expect.objectContaining({
        name: 'default',
        source: 'shipped',
        files: [
          join(DEFAULT_RULES_DIR, 'profiles', 'default', 'profile.json'),
          join(DEFAULT_RULES_DIR, 'profiles', 'default', 'standards.md'),
        ],
        setup: false,
      }),
    ]);
    expect(machine.profiles.steeringFiles.map(({ file }) => file)).toEqual([
      'charter.md',
      'reviewer.md',
      'permissions.json',
      'profile.json',
    ]);
    expect(machine.profiles.steeringFiles[3]).toMatchObject({
      machine: join(t.homeDir, LOCAL, 'rules.local.profile.json'),
      repo: null,
    });
    expect((await view('deck')).profiles.steeringFiles[1]?.repo).toBe(
      join(repoDir, LOCAL, 'rules.local.reviewer.md'),
    );
  });

  it('refuses to choose a profile that is not installed, then accepts a machine one', async () => {
    const missing = await t.send('rules.write', {
      scope: 'machine',
      name: 'profile',
      content: '{ "profile": "house" }',
    });
    expect(missing.status).toBe(400);
    expect(String(missing.body['error'])).toContain('no profile named house');

    const dir = join(t.homeDir, LOCAL, 'profiles', 'house');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'profile.json'),
      '{ "description": "The house style." }',
    );
    const chosen = await t.send('rules.write', {
      scope: 'machine',
      name: 'profile',
      content: '{ "profile": "house" }',
    });
    expect(chosen.status).toBe(200);
    const { profiles } = await view(null);
    expect(profiles).toMatchObject({ active: 'house', chosenBy: 'machine' });
    expect(profiles.profiles.map(({ name }) => name)).toEqual([
      'default',
      'house',
    ]);
  });

  it('keeps the Origin guard', async () => {
    const res = await fetch(`${t.api.url}/api/rules`, {
      headers: { origin: 'http://evil.example', ...bearer(t.api.token) },
    });
    expect(res.status).toBe(403);
  });
});
