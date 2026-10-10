import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupSignInTool, SetupTool } from '../../src/intents/index.js';
import type { SetupProbe } from '../../src/setup/index.js';
import type { SignInOutcome, SignInRunOptions } from '../../src/index.js';
import { TIMEOUT, startTestApi, type TestApi } from '../api/harness.js';

const tool = (
  signInTool: SetupSignInTool,
  installed: boolean,
  signedIn: boolean,
): SetupTool => ({
  tool: signInTool,
  name: JSON.stringify(signInTool),
  state: 'checked',
  installed,
  signedIn,
  hint: null,
});

interface FakeSignIn {
  runs: Array<{ tool: SetupSignInTool; options: SignInRunOptions }>;
  finish: (outcome: SignInOutcome) => void;
}

const fakeSignIn = (): FakeSignIn & {
  run: (t: SetupSignInTool, o: SignInRunOptions) => Promise<SignInOutcome>;
} => {
  const runs: FakeSignIn['runs'] = [];
  let finish: (outcome: SignInOutcome) => void = () => undefined;
  return {
    runs,
    finish: (outcome) => finish(outcome),
    run: (signInTool, options) => {
      runs.push({ tool: signInTool, options });
      options.onProgress?.({
        status: 'waiting',
        url: 'https://claude.ai/oauth',
        code: 'ABCD-1234',
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
};

describe('setup over the API', { timeout: TIMEOUT }, () => {
  let api: TestApi;
  let probed: Array<readonly string[]>;
  let signIn: ReturnType<typeof fakeSignIn>;
  let tools: SetupTool[];

  const probe: SetupProbe = {
    tools: async (repoPaths) => {
      probed.push(repoPaths);
      return tools;
    },
  };

  beforeEach(async () => {
    probed = [];
    signIn = fakeSignIn();
    tools = [
      tool({ kind: 'runtime', runtime: 'kiro' }, false, false),
      tool({ kind: 'runtime', runtime: 'claude' }, true, false),
      tool({ kind: 'runtime', runtime: 'gemini' }, false, false),
      tool({ kind: 'gh' }, true, true),
    ];
    api = await startTestApi([], undefined, {
      setupProbe: probe,
      setupSignIn: { run: signIn.run, openUrl: async () => undefined },
    });
    for (const name of ['deck', 'other']) {
      await mkdir(join(api.homeDir, 'work', name, '.git'), { recursive: true });
    }
  }, TIMEOUT);

  afterEach(async () => {
    signIn.finish({ ok: false, reason: 'test over' });
    await api.close();
  }, TIMEOUT);

  it('needs setup until a workspace is saved, then refuses a second setup', async () => {
    expect((await api.send('setup.read', {})).body).toMatchObject({
      result: { needsSetup: true, signIns: [] },
    });
    const saved = await api.send('setup.save', {
      root: '~/work/deck',
      runtime: 'claude',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      result: {
        mode: 'single',
        projects: ['deck'],
        runtime: 'claude',
        notice: null,
      },
    });
    expect((await api.send('setup.read', {})).body).toMatchObject({
      result: { needsSetup: false },
    });
    expect((await api.send('workspace.read', {})).body).toMatchObject({
      result: {
        workspace: {
          mode: 'single',
          root: join(api.homeDir, 'work', 'deck'),
          projects: [{ slug: 'deck' }],
        },
      },
    });
    const again = await api.send('setup.save', {
      root: join(api.homeDir, 'work', 'other'),
      runtime: 'claude',
    });
    expect(again.status).toBe(409);
  });

  it('needs no setup when projects are stored but no workspace file exists yet', async () => {
    await api.api.stores.create('deck');
    expect((await api.send('setup.read', {})).body).toMatchObject({
      result: { needsSetup: false },
    });
  });

  it('says whether a folder is one repository or several', async () => {
    const one = await api.send('setup.detect', { path: '~/work/deck' });
    expect(one.body).toMatchObject({
      result: {
        mode: 'single',
        repositories: [{ slug: 'deck', name: 'deck' }],
      },
    });
    const several = await api.send('setup.detect', { path: '~/work' });
    expect(several.body).toMatchObject({
      result: {
        mode: 'multi',
        repositories: [{ slug: 'deck' }, { slug: 'other' }],
      },
    });
    const relative = await api.send('setup.detect', { path: 'work/deck' });
    expect(relative.status).toBe(400);
    expect(String(relative.body['error'])).toContain('full path');
    const empty = await api.send('setup.detect', { path: '~' });
    expect(empty.status).toBe(400);
  });

  it('saves a folder of repositories as projects, leaving out the skipped ones', async () => {
    const saved = await api.send('setup.save', {
      root: join(api.homeDir, 'work'),
      runtime: 'claude',
      skip: ['other'],
    });
    expect(saved.body).toMatchObject({
      result: { mode: 'multi', projects: ['deck'] },
    });
    expect(await api.api.stores.list()).toEqual(['deck']);
    const none = await startTestApi([], undefined, { setupProbe: probe });
    try {
      await mkdir(join(none.homeDir, 'work', 'deck', '.git'), {
        recursive: true,
      });
      const refused = await none.send('setup.save', {
        root: join(none.homeDir, 'work'),
        runtime: 'claude',
        skip: ['deck'],
      });
      expect(refused.status).toBe(400);
      expect(refused.body['error']).toBe('No repositories to add.');
    } finally {
      await none.close();
    }
  });

  it('saves a runtime other than the default in ~/.quarterdeck, and refuses one a repository layer overrides', async () => {
    await api.send('setup.save', {
      root: join(api.homeDir, 'work', 'deck'),
      runtime: 'gemini',
    });
    const layer = JSON.parse(
      await readFile(
        join(api.homeDir, '.quarterdeck', 'rules.local.models.json'),
        'utf8',
      ),
    ) as Record<string, { runtime: string }>;
    expect(layer['driver']?.runtime).toBe('gemini');
    expect(layer['planner']?.runtime).toBe('gemini');

    const other = await startTestApi([], undefined, { setupProbe: probe });
    try {
      const repoPath = join(other.homeDir, 'work', 'deck');
      await mkdir(join(repoPath, '.git'), { recursive: true });
      await mkdir(join(repoPath, '.quarterdeck'), { recursive: true });
      await writeFile(
        join(repoPath, '.quarterdeck', 'rules.local.models.json'),
        '{}\n',
      );
      const refused = await other.send('setup.save', {
        root: repoPath,
        runtime: 'gemini',
      });
      expect(refused.status).toBe(409);
      expect(await other.api.stores.list()).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('writes a picked profile to ~/.quarterdeck/rules.local.profile.json, and refuses one not installed before creating anything', async () => {
    const refused = await api.send('setup.save', {
      root: join(api.homeDir, 'work', 'deck'),
      runtime: 'kiro',
      profile: 'nowhere',
    });
    expect(refused.status).toBe(400);
    expect(await api.api.stores.list()).toEqual([]);

    const saved = await api.send('setup.save', {
      root: join(api.homeDir, 'work', 'deck'),
      runtime: 'kiro',
      profile: 'default',
    });
    expect(saved.body).toMatchObject({ result: { profile: 'default' } });
    const layer = JSON.parse(
      await readFile(
        join(api.homeDir, '.quarterdeck', 'rules.local.profile.json'),
        'utf8',
      ),
    ) as unknown;
    expect(layer).toEqual({ profile: 'default' });
  });

  it('lists runtimes and the forges the workspace needs, defaulting to the only one installed', async () => {
    const listed = await api.send('setup.tools', { root: '~/work' });
    expect(listed.body).toMatchObject({
      result: {
        defaultRuntime: 'claude',
        runtimes: [
          { tool: { kind: 'runtime', runtime: 'kiro' }, installed: false },
          { tool: { kind: 'runtime', runtime: 'claude' }, installed: true },
          { tool: { kind: 'runtime', runtime: 'gemini' }, installed: false },
        ],
        forges: [{ tool: { kind: 'gh' }, signedIn: true }],
      },
    });
    expect(probed).toEqual([
      [join(api.homeDir, 'work', 'deck'), join(api.homeDir, 'work', 'other')],
    ]);
    await api.send('setup.tools', {});
    expect(probed.at(-1)).toEqual([]);

    tools = tools.map((entry) => ({ ...entry, installed: true }));
    const several = await api.send('setup.tools', {});
    expect(several.body).toMatchObject({ result: { defaultRuntime: 'kiro' } });
    tools = tools.map((entry) => ({ ...entry, installed: false }));
    const none = await api.send('setup.tools', {});
    expect(none.body).toMatchObject({ result: { defaultRuntime: null } });
  });

  it('answers 501 for runtime checks when nothing probes them', async () => {
    const bare = await startTestApi();
    try {
      expect((await bare.send('setup.tools', {})).status).toBe(501);
    } finally {
      await bare.close();
    }
  });

  it('runs a sign-in with no terminal and reports its progress until it settles', async () => {
    const claude = { kind: 'runtime', runtime: 'claude' } as const;
    const started = await api.send('setup.sign_in', { tool: claude });
    expect(started.body).toMatchObject({
      result: { signIn: { key: 'runtime:claude', tool: claude } },
    });
    expect(signIn.runs).toHaveLength(1);
    expect(signIn.runs[0]?.options.tty).toBe(false);
    await api.send('setup.sign_in', { tool: claude });
    expect(signIn.runs).toHaveLength(1);

    expect((await api.send('setup.read', {})).body).toMatchObject({
      result: {
        signIns: [
          {
            key: 'runtime:claude',
            name: 'Claude Code',
            progress: {
              status: 'waiting',
              url: 'https://claude.ai/oauth',
              code: 'ABCD-1234',
            },
          },
        ],
      },
    });
    signIn.finish({ ok: true, via: 'claude.ai' });
    await vi.waitFor(async () => {
      expect((await api.send('setup.read', {})).body).toMatchObject({
        result: { signIns: [{ progress: { status: 'signed_in' } }] },
      });
    });
    await api.send('setup.sign_in', { tool: claude });
    expect(signIn.runs).toHaveLength(2);
    signIn.finish({ ok: false, reason: 'browser closed' });
    await vi.waitFor(async () => {
      expect((await api.send('setup.read', {})).body).toMatchObject({
        result: {
          signIns: [
            { progress: { status: 'failed', message: 'browser closed' } },
          ],
        },
      });
    });
  });

  it('refuses a malformed sign-in tool and needs the token like every intent', async () => {
    const bad = await api.send('setup.sign_in', { tool: { kind: 'npm' } });
    expect(bad.status).toBe(400);
    const anonymous = await fetch(`${api.api.url}/api/intents/setup.read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(anonymous.status).toBe(401);
  });
});
