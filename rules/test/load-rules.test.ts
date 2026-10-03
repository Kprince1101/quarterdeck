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

const SHIPPED_AI_REVIEWERS = {
  github: ['copilot-pull-request-reviewer', 'Copilot'],
  gitlab: [],
};

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
      'env.json',
      'forges.json',
      'kiro.json',
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
    expect(rules.kiro).toEqual(await readDefaultJson('kiro.json'));
    expect(rules.charter).toContain('# Driver charter');
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
      window: { hours: 5, capTokens: null, holdAtFraction: 0.8 },
    });
    expect(lifecycle.stuckAfterMinutes).toBe(30);
  });

  it('ships no window cap and lets a local layer set one', async () => {
    expect((await loadRule('lifecycle', sandbox)).budget.window.capTokens).toBe(
      null,
    );
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      budget: { window: { capTokens: 1_000_000 } },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.budget.window).toEqual({
      hours: 5,
      capTokens: 1_000_000,
      holdAtFraction: 0.8,
    });
  });

  it('lets the repo layer only tighten the budget window', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      budget: { window: { capTokens: 1000, holdAtFraction: 0.7 } },
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      stuckAfterMinutes: 45,
      budget: {
        maxTokensPerTicket: 500,
        window: { hours: 1, capTokens: null, holdAtFraction: 0.9 },
      },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.stuckAfterMinutes).toBe(45);
    expect(lifecycle.budget).toEqual({
      maxTokensPerTicket: 500,
      warnAtFraction: 0.8,
      window: { hours: 5, capTokens: 1000, holdAtFraction: 0.7 },
    });
  });

  it('lets the repo layer set a smaller cap and a lower hold line', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      budget: { window: { capTokens: 1000 } },
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      budget: { window: { hours: 8, capTokens: 400, holdAtFraction: 0.5 } },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.budget.window).toEqual({
      hours: 8,
      capTokens: 400,
      holdAtFraction: 0.5,
    });
  });

  it('lets the repo layer set a cap when the machine has none', async () => {
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      budget: { window: { capTokens: 400 } },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.budget.window.capTokens).toBe(400);
  });

  it('tightens the budget window, the merge gate and the settle time from one repo layer', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 300,
      budget: { window: { capTokens: 1000 } },
      mergeGate: { autoMerge: true },
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      autoEndSettleSeconds: 60,
      budget: { window: { capTokens: null, holdAtFraction: 0.5 } },
      mergeGate: { autoMerge: true, requireAiReview: true },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.autoEndSettleSeconds).toBe(300);
    expect(lifecycle.budget.window).toEqual({
      hours: 5,
      capTokens: 1000,
      holdAtFraction: 0.5,
    });
    expect(lifecycle.mergeGate).toMatchObject({
      autoMerge: true,
      requireAiReview: true,
    });
  });

  it('rejects a window cap that is not a positive integer', async () => {
    const path = await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      budget: { window: { capTokens: 0 } },
    });

    await expect(loadRule('lifecycle', sandbox)).rejects.toMatchObject({
      path,
      message: expect.stringContaining('budget.window.capTokens'),
    });
  });

  it('ships the merge gate with auto merge and the AI review gate off', async () => {
    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.mergeGate).toEqual({
      requireReviewerApproval: true,
      requireChecksPassing: true,
      requireAiReview: false,
      aiReviewers: SHIPPED_AI_REVIEWERS,
      autoMerge: false,
    });
  });

  it('lets the home layer list AI reviewer logins per forge', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { aiReviewers: { gitlab: ['review-bot'] } },
    });

    expect(
      (await loadRule('lifecycle', sandbox)).mergeGate.aiReviewers,
    ).toEqual({ github: SHIPPED_AI_REVIEWERS.github, gitlab: ['review-bot'] });
  });

  it('refuses AI reviewer logins from the repo layer', async () => {
    const path = await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      mergeGate: { aiReviewers: { github: ['my-bot'] } },
    });

    await expect(loadRule('lifecycle', sandbox)).rejects.toThrow(
      `${path}: the repo layer may only tighten the merge gate`,
    );
  });

  it('reads the deprecated requireCopilotReview as requireAiReview, with a warning', async () => {
    const path = await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { requireCopilotReview: true },
    });
    const warnings: string[] = [];

    const lifecycle = await loadRule('lifecycle', {
      ...sandbox,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(lifecycle.mergeGate.requireAiReview).toBe(true);
    expect(lifecycle.mergeGate.aiReviewers.github).toEqual([
      'copilot-pull-request-reviewer',
      'Copilot',
    ]);
    expect(lifecycle.mergeGate).not.toHaveProperty('requireCopilotReview');
    expect(warnings).toEqual([
      `${path}: mergeGate.requireCopilotReview is deprecated and reads as mergeGate.requireAiReview; rename it`,
    ]);
  });

  it('lets the deprecated key in the repo layer only tighten, as before', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { requireAiReview: true },
    });
    const path = await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      mergeGate: { requireCopilotReview: false },
    });
    const warnings: string[] = [];
    const options = {
      ...sandbox,
      onWarning: (warning: string) => warnings.push(warning),
    };

    expect(
      (await loadRule('lifecycle', options)).mergeGate.requireAiReview,
    ).toBe(true);
    expect(warnings).toEqual([
      `${path}: mergeGate.requireCopilotReview is deprecated and reads as mergeGate.requireAiReview; rename it`,
    ]);

    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {});
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      mergeGate: { requireCopilotReview: true },
    });

    expect(
      (await loadRule('lifecycle', options)).mergeGate.requireAiReview,
    ).toBe(true);
  });

  it('turns the gate on when either key in one layer does', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { requireAiReview: false, requireCopilotReview: true },
    });

    const lifecycle = await loadRule('lifecycle', {
      ...sandbox,
      onWarning: () => undefined,
    });

    expect(lifecycle.mergeGate.requireAiReview).toBe(true);
  });

  it('still rejects a deprecated key that is not a boolean', async () => {
    const path = await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { requireCopilotReview: 'yes' },
    });

    await expect(
      loadRule('lifecycle', { ...sandbox, onWarning: () => undefined }),
    ).rejects.toMatchObject({
      path,
      message: expect.stringContaining('mergeGate.requireAiReview'),
    });
  });

  it('turns auto merge on from the home layer, keeping the other gates', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { autoMerge: true, base: 'trunk' },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.mergeGate.autoMerge).toBe(true);
    expect(lifecycle.mergeGate.base).toBe('trunk');
    expect(lifecycle.mergeGate.requireChecksPassing).toBe(true);
  });

  it('lets the repo layer only tighten the merge gate', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { autoMerge: true, requireChecksPassing: false },
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      stuckAfterMinutes: 45,
      mergeGate: {
        requireReviewerApproval: false,
        requireChecksPassing: true,
        requireAiReview: true,
        autoMerge: true,
      },
    });

    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.stuckAfterMinutes).toBe(45);
    expect(lifecycle.mergeGate).toEqual({
      requireReviewerApproval: true,
      requireChecksPassing: true,
      requireAiReview: true,
      aiReviewers: SHIPPED_AI_REVIEWERS,
      autoMerge: true,
    });
  });

  it('lets the repo layer turn auto merge off but never on', async () => {
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      mergeGate: { autoMerge: true, requireReviewerApproval: false },
    });

    expect((await loadRule('lifecycle', sandbox)).mergeGate).toMatchObject({
      autoMerge: false,
      requireReviewerApproval: true,
    });

    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { autoMerge: true },
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      mergeGate: { autoMerge: false },
    });

    expect((await loadRule('lifecycle', sandbox)).mergeGate.autoMerge).toBe(
      false,
    );
  });

  it('refuses a merge gate base from the repo layer', async () => {
    const path = await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      mergeGate: { base: 'release' },
    });

    await expect(loadRule('lifecycle', sandbox)).rejects.toThrow(
      `${path}: the repo layer may only tighten the merge gate`,
    );
  });

  it('ships the auto-end settle time with the other lifecycle defaults', async () => {
    const lifecycle = await loadRule('lifecycle', sandbox);

    expect(lifecycle.autoEndSettleSeconds).toBe(120);
  });

  it('lets the repo layer lengthen the auto-end settle time but never shorten it', async () => {
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      autoEndSettleSeconds: 5,
    });

    expect((await loadRule('lifecycle', sandbox)).autoEndSettleSeconds).toBe(
      120,
    );

    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      autoEndSettleSeconds: 600,
    });

    expect((await loadRule('lifecycle', sandbox)).autoEndSettleSeconds).toBe(
      600,
    );
  });

  it('lets the home layer shorten the settle time the repo layer cannot', async () => {
    await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 10,
    });
    await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      autoEndSettleSeconds: 30,
    });

    expect((await loadRule('lifecycle', sandbox)).autoEndSettleSeconds).toBe(
      30,
    );
  });

  it('refuses a repo settle time that is not a positive whole number', async () => {
    const path = await writeLocalJson(sandbox.repoDir, 'lifecycle.json', {
      autoEndSettleSeconds: 0,
    });

    await expect(loadRule('lifecycle', sandbox)).rejects.toThrow(
      `${path}: the repo layer may only tighten the auto-end settle time`,
    );
  });

  it('rejects a merge gate setting that is not a boolean', async () => {
    const path = await writeLocalJson(sandbox.homeDir, 'lifecycle.json', {
      mergeGate: { autoMerge: 'yes' },
    });

    await expect(loadRule('lifecycle', sandbox)).rejects.toThrow(path);
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
      sandbox.homeDir,
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

  it('ships no Kiro base agent for any role', async () => {
    expect(await loadRule('kiro', sandbox)).toEqual({
      baseAgents: { driver: null, reviewer: null, builder: null },
    });
  });

  it('lets the machine set every base and the project only the builder', async () => {
    await writeLocalJson(sandbox.homeDir, 'kiro.json', {
      baseAgents: { driver: 'everyday', reviewer: 'security', builder: 'a' },
    });
    await writeLocalJson(sandbox.repoDir, 'kiro.json', {
      baseAgents: { builder: 'library-builder' },
    });

    expect(await loadRule('kiro', sandbox)).toEqual({
      baseAgents: {
        driver: 'everyday',
        reviewer: 'security',
        builder: 'library-builder',
      },
    });
  });

  it.each(['driver', 'reviewer'])(
    'refuses a project layer that sets the %s base',
    async (role) => {
      const path = await writeLocalJson(sandbox.repoDir, 'kiro.json', {
        baseAgents: { [role]: 'everyday' },
      });

      await expect(loadRule('kiro', sandbox)).rejects.toMatchObject({
        name: 'RulesError',
        path,
        message: expect.stringContaining("only set the builder's base agent"),
      });
    },
  );

  it('refuses a Kiro base agent name that is not a file name', async () => {
    const path = await writeLocalJson(sandbox.homeDir, 'kiro.json', {
      baseAgents: { builder: '../escape' },
    });

    await expect(loadRule('kiro', sandbox)).rejects.toMatchObject({ path });
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
