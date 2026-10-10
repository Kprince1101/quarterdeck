import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { STEERING_START } from '@quarterdeck/rules';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  crewRules,
  reviewerBrief,
  type CrewRules,
} from '../../src/crew/rules.js';
import { builderContext, type VoyageLeg } from '../../src/crew/voyage-legs.js';
import {
  buildAssignmentPrompt,
  buildBirthInput,
  type BuilderContext,
} from '../../src/driver/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

const HOUSE_STANDARDS = 'House standard: every module exports one thing.';
const HOUSE_PHILOSOPHY = 'House philosophy: prefer boring code.';
const HOUSE_MARKERS = [HOUSE_STANDARDS, HOUSE_PHILOSOPHY, 'House', 'house'];

interface Box {
  root: string;
  homeDir: string;
  repoDir: string;
}

const writeJson = async (path: string, value: unknown) => {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

const installHouse = async (box: Box) => {
  const docs = resolve(box.root, 'docs');
  await mkdir(docs);
  await writeFile(resolve(docs, 'HOUSE-STANDARDS.md'), HOUSE_STANDARDS);
  await writeFile(resolve(docs, 'HOUSE-PHILOSOPHY.md'), HOUSE_PHILOSOPHY);
  await writeJson(
    resolve(box.homeDir, '.quarterdeck', 'profiles', 'house', 'profile.json'),
    {
      description: 'The house style.',
      standards: [
        resolve(docs, 'HOUSE-STANDARDS.md'),
        resolve(docs, 'HOUSE-PHILOSOPHY.md'),
      ],
      levels: { 'no-ternary': 3, 'max-lines': 2 },
    },
  );
};

const choose = (dir: string, profile: string) =>
  writeJson(resolve(dir, '.quarterdeck', 'rules.local.profile.json'), {
    profile,
  });

const builderPrompt = async (ctx: BuilderContext): Promise<string> =>
  buildAssignmentPrompt({
    builder: { name: 'okapi' },
    ticket: {
      id: 't1',
      title: 'Add the greeting',
      body: 'Say hello.',
      prUrl: null,
      headSha: null,
      externalRef: null,
    },
    worktreePath: '/wt/okapi',
    repoPath: ctx.repoPath,
    base: ctx.base,
    terms: ctx.terms,
    services: ctx.services,
    standards: await ctx.standards?.(),
  });

const legFor = (store: Store, rules: CrewRules, repoPath: string): VoyageLeg =>
  ({
    project: 'deck',
    store,
    rules,
    repoPath,
    voyageId: 'v1',
  }) as unknown as VoyageLeg;

const driverBirth = async (rules: CrewRules): Promise<string> =>
  buildBirthInput({
    agent: { name: 'heron' },
    voyage: { number: 1, goal: 'Ship it.' },
    charter: await rules.load('charter'),
    notebook: [],
    instructions: 'Reply with JSON.',
  });

const kickoffPrompts = async (
  store: Store,
  rules: CrewRules,
  repoPath: string,
): Promise<{ builder: string; reviewer: string; driver: string }> => {
  const ctx = await builderContext(legFor(store, rules, repoPath), '/qd');
  return {
    builder: await builderPrompt(ctx),
    reviewer: await reviewerBrief(rules),
    driver: await driverBirth(rules),
  };
};

describe('rules profile at kickoff', () => {
  let box: Box;
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-kickoff-'));
    box = {
      root,
      homeDir: resolve(root, 'home'),
      repoDir: resolve(root, 'repo'),
    };
    await mkdir(box.homeDir);
    await mkdir(box.repoDir);
  });

  afterEach(async () => {
    await rm(box.root, { recursive: true, force: true });
  });

  const rulesFor = (): CrewRules =>
    crewRules(store, box.homeDir, async () => 'github');

  const setRepoPath = (repoPath: string) =>
    store.db.query('update projects set repo_path = $1 where id = $2', [
      repoPath,
      store.projectId,
    ]);

  it('puts no machine-profile text in any kickoff prompt on a fresh default clone', async () => {
    await installHouse(box);
    await setRepoPath(box.repoDir);

    const prompts = await kickoffPrompts(store, rulesFor(), box.repoDir);

    expect(prompts.builder).toContain('# Standards');
    expect(prompts.builder).toContain('From the `default` rules profile.');
    expect(prompts.reviewer).toContain('From the `default` rules profile.');
    for (const prompt of Object.values(prompts)) {
      for (const marker of HOUSE_MARKERS) expect(prompt).not.toContain(marker);
      expect(prompt).not.toContain(STEERING_START);
      expect(prompt).not.toContain('# Steering');
    }
  });

  it("gives builders and the reviewer a machine profile's standards and steering block", async () => {
    await installHouse(box);
    await choose(box.homeDir, 'house');
    await setRepoPath(box.repoDir);

    const prompts = await kickoffPrompts(store, rulesFor(), box.repoDir);

    for (const prompt of [prompts.builder, prompts.reviewer]) {
      expect(prompt).toContain('From the `house` rules profile.');
      expect(prompt).toContain(HOUSE_STANDARDS);
      expect(prompt).toContain(HOUSE_PHILOSOPHY);
      expect(prompt).toContain(`# Steering\n\n${STEERING_START}`);
      expect(prompt).toContain('- `no-ternary`: 3, enforced and locked');
    }
    expect(prompts.builder.indexOf('# Standards')).toBeLessThan(
      prompts.builder.indexOf('# When you are done'),
    );
  });

  it('lets the per-project override win over the machine profile', async () => {
    await installHouse(box);
    await choose(box.homeDir, 'house');
    await choose(box.repoDir, 'default');
    await setRepoPath(box.repoDir);

    const prompts = await kickoffPrompts(store, rulesFor(), box.repoDir);

    expect(prompts.builder).toContain('From the `default` rules profile.');
    expect(prompts.reviewer).toContain('From the `default` rules profile.');
    expect(prompts.builder).not.toContain(HOUSE_STANDARDS);
    expect(prompts.reviewer).not.toContain(HOUSE_STANDARDS);
  });

  it('uses the per-project override to opt one project into a machine profile', async () => {
    await installHouse(box);
    await choose(box.repoDir, 'house');
    await setRepoPath(box.repoDir);

    const { builder } = await kickoffPrompts(store, rulesFor(), box.repoDir);

    expect(builder).toContain(HOUSE_STANDARDS);
  });
});
