import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_DIR,
  RulesError,
  STEERING_END,
  STEERING_START,
  activeProfile,
  describeProfiles,
  kickoffSection,
  loadRule,
  profileKickoff,
  renderSteeringBlock,
  writeSteeringBlock,
} from '@quarterdeck/rules';

const HOUSE_STANDARDS = 'House standard: every module exports one thing.';
const HOUSE_PHILOSOPHY = 'House philosophy: prefer boring code.';
const HOUSE_REVIEWER =
  'House review: reject any module that exports two things.';

interface Box {
  root: string;
  homeDir: string;
  repoDir: string;
  docsDir: string;
}

const write = async (path: string, content: string) => {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, content);
};

const writeJson = (path: string, value: unknown) =>
  write(path, JSON.stringify(value));

const houseDir = (box: Box) =>
  resolve(box.homeDir, '.quarterdeck', 'profiles', 'house');

const addHouse = async (box: Box, manifest: Record<string, unknown> = {}) => {
  const standards = resolve(box.docsDir, 'HOUSE-STANDARDS.md');
  const philosophy = resolve(box.docsDir, 'HOUSE-PHILOSOPHY.md');
  await write(standards, `${HOUSE_STANDARDS}\n`);
  await write(philosophy, `${HOUSE_PHILOSOPHY}\n`);
  await writeJson(resolve(houseDir(box), 'profile.json'), {
    description: 'The house style.',
    standards: [standards, philosophy],
    levels: { 'no-ternary': 3, 'max-lines': 2, 'no-console': 1, 'no-var': 0 },
    ...manifest,
  });
};

const choose = (dir: string, value: unknown) =>
  writeJson(resolve(dir, '.quarterdeck', 'rules.local.profile.json'), value);

describe('rules profiles', () => {
  let box: Box;

  beforeEach(async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-profiles-'));
    box = {
      root,
      homeDir: resolve(root, 'home'),
      repoDir: resolve(root, 'repo'),
      docsDir: resolve(root, 'docs'),
    };
    await mkdir(box.homeDir);
    await mkdir(box.repoDir);
  });

  afterEach(async () => {
    await rm(box.root, { recursive: true, force: true });
  });

  it('ships the default profile as the active one', async () => {
    const profile = await activeProfile(box);

    expect(profile).toEqual({
      name: 'default',
      dir: resolve(DEFAULT_RULES_DIR, 'profiles', 'default'),
      source: 'shipped',
      chosenBy: 'shipped',
      levels: {},
      repoLevels: {},
    });
  });

  it('gives the default profile a generic standards doc and no steering block', async () => {
    await addHouse(box);
    const kickoff = await profileKickoff(box);

    expect(kickoff.profile).toBe('default');
    expect(kickoff.standards).toContain(
      'working rules every Quarterdeck agent',
    );
    expect(kickoff.steering).toBe('');
    const section = kickoffSection(kickoff);
    expect(section).toContain('# Standards');
    expect(section).not.toContain('# Steering');
    expect(section).not.toContain('House');
  });

  it("gives a machine profile's kickoff its standards docs and steering block", async () => {
    await addHouse(box);
    await choose(box.homeDir, { profile: 'house' });

    const kickoff = await profileKickoff(box);
    const section = kickoffSection(kickoff);

    expect(kickoff.standards).toBe(`${HOUSE_STANDARDS}\n\n${HOUSE_PHILOSOPHY}`);
    expect(section).toContain('From the `house` rules profile.');
    expect(section).toContain(HOUSE_STANDARDS);
    expect(section).toContain(HOUSE_PHILOSOPHY);
    expect(section).toContain(STEERING_START);
    expect(section).toContain('- `no-ternary`: 3, enforced and locked');
    expect(section).toContain('- `max-lines`: 2, enforced; a scoped disable');
    expect(section).toContain('- `no-console`: 1, warns');
    expect(section).toContain('- `no-var`: 0, off');
  });

  it('lets a per-project override win over the machine profile', async () => {
    await addHouse(box);
    await choose(box.homeDir, { profile: 'house' });
    await choose(box.repoDir, { profile: 'default' });

    expect((await profileKickoff({ homeDir: box.homeDir })).profile).toBe(
      'house',
    );
    const project = await activeProfile(box);
    expect(project).toMatchObject({ name: 'default', chosenBy: 'project' });
    expect(kickoffSection(await profileKickoff(box))).not.toContain('House');
  });

  it('lets a project pick a machine profile the machine does not use', async () => {
    await addHouse(box);
    await choose(box.repoDir, { profile: 'house' });

    expect(await activeProfile({ homeDir: box.homeDir })).toMatchObject({
      name: 'default',
    });
    expect((await profileKickoff(box)).standards).toContain(HOUSE_STANDARDS);
  });

  it('applies local levels over the profile levels', async () => {
    await addHouse(box);
    await choose(box.homeDir, {
      profile: 'house',
      levels: { 'no-ternary': 1 },
    });
    await choose(box.repoDir, { levels: { 'no-var': 2 } });

    const { steering } = await profileKickoff(box);

    expect(steering).toContain('- `no-ternary`: 1, warns');
    expect(steering).toContain('- `no-var`: 2, enforced');
  });

  it('lets the repo layer raise a level but never lower one', async () => {
    await addHouse(box);
    await choose(box.homeDir, { profile: 'house', levels: { 'no-var': 1 } });
    await choose(box.repoDir, {
      levels: { 'no-ternary': 0, 'max-lines': 3, 'no-var': 0, 'new-rule': 2 },
    });

    const { steering } = await profileKickoff(box);

    expect(steering).toContain('- `no-ternary`: 3, enforced and locked');
    expect(steering).toContain('- `max-lines`: 3, enforced and locked');
    expect(steering).toContain('- `no-var`: 1, warns');
    expect(steering).toContain('- `new-rule`: 2, enforced');
    expect(await activeProfile(box)).toMatchObject({
      levels: { 'no-var': 1 },
      repoLevels: {
        'no-ternary': 0,
        'max-lines': 3,
        'no-var': 0,
        'new-rule': 2,
      },
    });
  });

  it("reads the steering block a profile's steer tool wrote into the repo", async () => {
    await addHouse(box, {
      steering: {
        file: 'AGENTS.md',
        start: '<!-- house:start -->',
        end: '<!-- house:end -->',
      },
    });
    await choose(box.homeDir, { profile: 'house' });
    const block =
      '<!-- house:start -->\nEnforced: one export.\n<!-- house:end -->';
    await write(
      resolve(box.repoDir, 'AGENTS.md'),
      `# Agents\n\n${block}\n\nMore.\n`,
    );

    expect((await profileKickoff(box)).steering).toBe(block);
    expect((await profileKickoff({ homeDir: box.homeDir })).steering).toContain(
      STEERING_START,
    );
  });

  it("adds a profile's reviewer rules and merge gate to the shipped rules", async () => {
    await addHouse(box);
    await write(resolve(houseDir(box), 'reviewer.md'), `${HOUSE_REVIEWER}\n`);
    await writeJson(resolve(houseDir(box), 'lifecycle.json'), {
      mergeGate: { requireAiReview: true, autoMerge: true },
    });

    expect(await loadRule('reviewer', box)).not.toContain(HOUSE_REVIEWER);
    await choose(box.homeDir, { profile: 'house' });

    const reviewer = await loadRule('reviewer', box);
    expect(reviewer).toContain('# Reviewer');
    expect(reviewer.trimEnd().endsWith(HOUSE_REVIEWER)).toBe(true);
    const lifecycle = await loadRule('lifecycle', box);
    expect(lifecycle.mergeGate).toMatchObject({
      requireAiReview: true,
      autoMerge: true,
      requireReviewerApproval: true,
    });
  });

  it('keeps the merge gate tighten-only when a project picks the profile', async () => {
    await addHouse(box);
    await writeJson(resolve(houseDir(box), 'lifecycle.json'), {
      mergeGate: { requireAiReview: true, autoMerge: true },
    });
    await choose(box.repoDir, { profile: 'house' });

    const lifecycle = await loadRule('lifecycle', box);

    expect(lifecycle.mergeGate.requireAiReview).toBe(true);
    expect(lifecycle.mergeGate.autoMerge).toBe(false);
  });

  it('names the missing profile and where to add it', async () => {
    await choose(box.homeDir, { profile: 'nowhere' });

    const failure = activeProfile(box);
    await expect(failure).rejects.toBeInstanceOf(RulesError);
    await expect(failure).rejects.toThrow('no profile named nowhere');
    expect((await describeProfiles(box)).error).toContain(
      'no profile named nowhere',
    );
  });

  it('describes every profile with the files it reads', async () => {
    await addHouse(box, {
      setup: { levelsFile: 'house.levels.json' },
    });
    await write(resolve(houseDir(box), 'reviewer.md'), HOUSE_REVIEWER);
    await choose(box.homeDir, { profile: 'house' });

    const view = await describeProfiles(box);

    expect(view).toMatchObject({
      active: 'house',
      chosenBy: 'machine',
      error: null,
    });
    expect(
      view.profiles.map(({ name, source }) => `${name}:${source}`),
    ).toEqual(['default:shipped', 'house:machine']);
    const house = view.profiles[1];
    expect(house?.files).toEqual([
      resolve(houseDir(box), 'profile.json'),
      resolve(box.docsDir, 'HOUSE-STANDARDS.md'),
      resolve(box.docsDir, 'HOUSE-PHILOSOPHY.md'),
      resolve(houseDir(box), 'reviewer.md'),
      resolve(box.repoDir, 'house.levels.json'),
    ]);
    expect(house?.setup).toBe(true);
  });

  it('does not let a machine profile shadow a shipped one', async () => {
    await writeJson(
      resolve(
        box.homeDir,
        '.quarterdeck',
        'profiles',
        'default',
        'profile.json',
      ),
      { description: 'An impostor.' },
    );

    expect(await activeProfile(box)).toMatchObject({ source: 'shipped' });
  });

  it('writes the steering block into a file once, replacing it later', () => {
    const first = renderSteeringBlock('house', { a: 3 });
    const second = renderSteeringBlock('house', { a: 1 });

    expect(renderSteeringBlock('house', {})).toBe('');
    const once = writeSteeringBlock('# Agents\n', first);
    expect(once).toBe(`# Agents\n\n${first}\n`);
    const twice = writeSteeringBlock(once, second);
    expect(twice).toBe(`# Agents\n\n${second}\n`);
    expect(twice.split(STEERING_END)).toHaveLength(2);
    expect(writeSteeringBlock('', first)).toBe(`${first}\n`);
  });

  it('ships a language-neutral default standards doc', async () => {
    const standards = await readFile(
      resolve(DEFAULT_RULES_DIR, 'profiles', 'default', 'standards.md'),
      'utf8',
    );

    for (const word of [
      'React',
      'TypeScript',
      'JSX',
      'component',
      'hook',
      'ternar',
    ])
      expect(standards).not.toContain(word);
  });
});
