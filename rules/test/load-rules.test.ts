import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_DIR,
  RULE_FILES,
  RULE_NAMES,
  RulesError,
  loadRule,
  loadRules,
  ruleLayerPaths,
} from '@quarterdeck/rules';

interface Sandbox {
  homeDir: string;
  repoDir: string;
}

const writeLocal = async (dir: string, file: string, content: string) => {
  const target = resolve(dir, '.quarterdeck', `rules.local.${file}`);
  await mkdir(resolve(dir, '.quarterdeck'), { recursive: true });
  await writeFile(target, content);
  return target;
};

const writeLocalJson = (dir: string, file: string, value: unknown) =>
  writeLocal(dir, file, JSON.stringify(value));

const readDefaultJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(DEFAULT_RULES_DIR, file), 'utf8'));

describe('rules loader', () => {
  let root = '';
  let sandbox: Sandbox = { homeDir: '', repoDir: '' };

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-rules-'));
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

  it('ships every default rule file', () => {
    expect(Object.values(RULE_FILES).toSorted()).toEqual([
      'charter.md',
      'lifecycle.json',
      'models.json',
      'naming.json',
      'permissions.json',
      'reviewer.md',
    ]);
  });

  it('loads the shipped defaults unchanged when no local files exist', async () => {
    const rules = await loadRules(sandbox);

    expect(Object.keys(rules).toSorted()).toEqual(RULE_NAMES.toSorted());
    expect(rules.permissions).toEqual(
      await readDefaultJson('permissions.json'),
    );
    expect(rules.naming).toEqual(await readDefaultJson('naming.json'));
    expect(rules.lifecycle).toEqual(await readDefaultJson('lifecycle.json'));
    expect(rules.models).toEqual(await readDefaultJson('models.json'));
    expect(rules.charter).toContain('# Agent charter');
    expect(rules.reviewer).toContain('# Reviewer');
  });

  it('orders layers defaults, then home, then repo', () => {
    const layers = ruleLayerPaths('naming', sandbox);

    expect(layers).toEqual({
      defaults: resolve(DEFAULT_RULES_DIR, 'naming.json'),
      local: [
        resolve(sandbox.homeDir, '.quarterdeck/rules.local.naming.json'),
        resolve(sandbox.repoDir, '.quarterdeck/rules.local.naming.json'),
      ],
    });
  });

  it('skips the repo layer when no repo is given', () => {
    const layers = ruleLayerPaths('naming', { homeDir: sandbox.homeDir });

    expect(layers.local).toEqual([
      resolve(sandbox.homeDir, '.quarterdeck/rules.local.naming.json'),
    ]);
  });

  it('deep-merges home JSON over the defaults', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      budget: { maxTokensPerTicket: 500 },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.budget).toEqual({
      maxTokensPerTicket: 500,
      warnAtFraction: 0.8,
    });
    expect(lifecycle.stuckAfterMinutes).toBe(30);
  });

  it('lets the repo layer win over the home layer', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      stuckAfterMinutes: 10,
      autoEndSettleSeconds: 5,
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      stuckAfterMinutes: 45,
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.stuckAfterMinutes).toBe(45);
    expect(lifecycle.autoEndSettleSeconds).toBe(5);
  });

  it('replaces arrays instead of concatenating them', async () => {
    await writeLocalJson(sandbox.repoDir, 'naming.json', {
      names: ['alpha', 'bravo'],
    });

    const naming = await loadRule('naming', sandbox);

    expect(naming).toEqual({ theme: 'animals', names: ['alpha', 'bravo'] });
  });

  it('replaces markdown wholesale with the highest layer', async () => {
    await writeLocal(sandbox.homeDir, 'charter.md', '# Home charter\n');
    await writeLocal(sandbox.repoDir, 'charter.md', '# Repo charter\n');
    await writeLocal(sandbox.homeDir, 'reviewer.md', '# Home reviewer\n');

    const rules = await loadRules(sandbox);

    expect(rules.charter).toBe('# Repo charter');
    expect(rules.reviewer).toBe('# Home reviewer');
  });

  it('names the local file that is not valid JSON', async () => {
    const path = await writeLocal(sandbox.repoDir, 'models.json', '{ nope');

    const load = loadRule('models', sandbox);

    await expect(load).rejects.toBeInstanceOf(RulesError);
    await expect(load).rejects.toMatchObject({ path });
  });

  it('names the local file whose merge breaks the schema', async () => {
    const path = await writeLocalJson(sandbox.homeDir, 'models.json', {
      builder: { runtime: 'copilot' },
    });

    await expect(loadRule('models', sandbox)).rejects.toMatchObject({
      name: 'RulesError',
      path,
      message: expect.stringContaining('builder.runtime'),
    });
  });

  it('rejects unknown keys so typos surface', async () => {
    const path = await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      stuckAfterMinute: 5,
    });

    await expect(loadRule('lifecycle', sandbox)).rejects.toMatchObject({
      path,
      message: expect.stringContaining('stuckAfterMinute'),
    });
  });

  it('rejects a __proto__ key instead of reshaping the merged object', async () => {
    const path = await writeLocal(
      sandbox.repoDir,
      'permissions.json',
      '{ "__proto__": { "default": "allow" } }',
    );

    await expect(loadRule('permissions', sandbox)).rejects.toMatchObject({
      path,
    });
  });

  it('rejects an empty markdown override', async () => {
    const path = await writeLocal(sandbox.homeDir, 'reviewer.md', '  \n');

    await expect(loadRule('reviewer', sandbox)).rejects.toMatchObject({
      path,
    });
  });

  it('rejects duplicate agent names', async () => {
    await writeLocalJson(sandbox.homeDir, 'naming.json', {
      names: ['okapi', 'okapi'],
    });

    await expect(loadRule('naming', sandbox)).rejects.toThrow(
      'names must be unique',
    );
  });

  it('names a missing defaults file', async () => {
    const defaultsDir = resolve(root, 'empty-defaults');
    const path = resolve(defaultsDir, 'permissions.json');

    await expect(
      loadRule('permissions', { ...sandbox, defaultsDir }),
    ).rejects.toMatchObject({ path });
  });

  it('names an invalid defaults file', async () => {
    const defaultsDir = resolve(root, 'bad-defaults');
    const path = resolve(defaultsDir, 'permissions.json');
    await mkdir(defaultsDir);
    await writeFile(path, JSON.stringify({ default: 'maybe', rules: [] }));

    await expect(
      loadRule('permissions', { ...sandbox, defaultsDir }),
    ).rejects.toMatchObject({ path });
  });
});
