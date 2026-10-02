import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_DIR,
  RulesError,
  loadPermissionLayers,
  loadRepoPermissions,
  loadRule,
  loadRules,
  repoPermissionsPath,
} from '@quarterdeck/rules';

interface Sandbox {
  homeDir: string;
  repoDir: string;
}

const writePermissions = async (dir: string, content: string) => {
  const target = resolve(dir, '.quarterdeck', 'rules.local.permissions.json');
  await mkdir(resolve(dir, '.quarterdeck'), { recursive: true });
  await writeFile(target, content);
  return target;
};

const writePermissionsJson = (dir: string, value: unknown) =>
  writePermissions(dir, JSON.stringify(value));

const readDefaults = async (): Promise<unknown> =>
  JSON.parse(
    await readFile(resolve(DEFAULT_RULES_DIR, 'permissions.json'), 'utf8'),
  );

describe('permission layers', () => {
  let root = '';
  let sandbox: Sandbox = { homeDir: '', repoDir: '' };

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-permissions-'));
    sandbox = {
      homeDir: resolve(root, 'home'),
      repoDir: resolve(root, 'repo'),
    };
    await mkdir(sandbox.homeDir);
    await mkdir(sandbox.repoDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('places the repo layer under the repo .quarterdeck folder', () => {
    expect(repoPermissionsPath(sandbox.repoDir)).toBe(
      resolve(sandbox.repoDir, '.quarterdeck/rules.local.permissions.json'),
    );
  });

  it('loads the defaults alone when no local layer exists', async () => {
    expect(await loadPermissionLayers(sandbox)).toEqual({
      machine: await readDefaults(),
    });
  });

  it('merges the home layer into the machine rules, loosening allowed', async () => {
    await writePermissionsJson(sandbox.homeDir, {
      rules: [{ kind: 'edit', decision: 'allow' }],
    });

    const layers = await loadPermissionLayers(sandbox);

    expect(layers.machine).toEqual({
      default: 'ask',
      rules: [{ kind: 'edit', decision: 'allow' }],
    });
  });

  it('keeps the repo layer apart instead of merging it over the machine rules', async () => {
    await writePermissionsJson(sandbox.repoDir, {
      default: 'deny',
      rules: [{ kind: 'execute', pattern: 'rm *', decision: 'deny' }],
    });

    const layers = await loadPermissionLayers(sandbox);

    expect(layers.machine).toEqual(await readDefaults());
    expect(layers.repo).toEqual({
      default: 'deny',
      rules: [{ kind: 'execute', pattern: 'rm *', decision: 'deny' }],
    });
  });

  it('never lets loadRule merge the repo layer into permissions', async () => {
    await writePermissionsJson(sandbox.repoDir, { default: 'deny' });

    expect(await loadRule('permissions', sandbox)).toEqual(
      await readDefaults(),
    );
    expect((await loadRules(sandbox)).permissions).toEqual(
      await readDefaults(),
    );
  });

  it('skips the repo layer when no repo is given', async () => {
    await writePermissionsJson(sandbox.repoDir, { default: 'deny' });

    expect(
      await loadPermissionLayers({ homeDir: sandbox.homeDir }),
    ).not.toHaveProperty('repo');
  });

  it('rejects a repo layer that tries to allow anything', async () => {
    const path = await writePermissionsJson(sandbox.repoDir, {
      rules: [{ kind: 'execute', decision: 'allow' }],
    });

    const load = loadPermissionLayers(sandbox);

    await expect(load).rejects.toBeInstanceOf(RulesError);
    await expect(load).rejects.toMatchObject({
      path,
      message: expect.stringContaining('may only tighten'),
    });
  });

  it('rejects a repo layer whose default is allow', async () => {
    const path = await writePermissionsJson(sandbox.repoDir, {
      default: 'allow',
    });

    await expect(loadRepoPermissions(sandbox.repoDir)).rejects.toMatchObject({
      path,
    });
  });

  it('names a repo layer that is not valid JSON', async () => {
    const path = await writePermissions(sandbox.repoDir, '{ nope');

    await expect(loadRepoPermissions(sandbox.repoDir)).rejects.toMatchObject({
      path,
    });
  });

  it('rejects unknown keys in the repo layer', async () => {
    const path = await writePermissionsJson(sandbox.repoDir, {
      rule: [{ kind: 'read', decision: 'deny' }],
    });

    await expect(loadRepoPermissions(sandbox.repoDir)).rejects.toMatchObject({
      path,
      message: expect.stringContaining('rule'),
    });
  });

  it('rejects a __proto__ key in the repo layer', async () => {
    const path = await writePermissions(
      sandbox.repoDir,
      '{ "__proto__": { "default": "deny" } }',
    );

    await expect(loadRepoPermissions(sandbox.repoDir)).rejects.toMatchObject({
      path,
    });
  });
});
