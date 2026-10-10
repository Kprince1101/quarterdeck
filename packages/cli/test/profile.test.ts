import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeProfile, profileKickoff } from '@quarterdeck/rules';
import { quarterdeckHome } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIo } from '../src/index.js';
import {
  entries,
  sandbox,
  testIo,
  type Sandbox,
  type TestIo,
} from './harness.js';

const TIMEOUT = 30_000;
const SLUG = 'deck-repo';

const profile = (args: string[], io: CliIo) => main(['profile', ...args], io);

const houseDir = (home: string) =>
  join(quarterdeckHome(home), 'profiles', 'house');

const machineChoice = (home: string) =>
  join(quarterdeckHome(home), 'rules.local.profile.json');

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

const recordingIo = (home: string, answers?: string[]) => {
  const io: TestIo = testIo(home, answers);
  const ran: { command: string[]; cwd: string }[] = [];
  io.run = (command, cwd) => {
    ran.push({ command: [...command], cwd });
    return Promise.resolve();
  };
  return { io, ran };
};

describe('quarterdeck profile', { timeout: TIMEOUT }, () => {
  let box: Sandbox;
  let docs = '';

  beforeEach(async () => {
    box = await sandbox();
    docs = join(box.home, 'docs');
    await mkdir(docs);
    await writeFile(join(docs, 'STANDARDS.md'), 'House standard.\n');
    await writeFile(join(docs, 'PHILOSOPHY.md'), 'House philosophy.\n');
    await writeFile(
      join(docs, 'levels.json'),
      JSON.stringify({ 'no-ternary': 3, 'max-lines': 2 }),
    );
  });

  afterEach(async () => {
    await box.close();
  });

  const addHouse = async (io: CliIo) =>
    profile(
      [
        'add',
        'house',
        '--standards',
        join(docs, 'STANDARDS.md'),
        '--philosophy',
        join(docs, 'PHILOSOPHY.md'),
        '--levels',
        join(docs, 'levels.json'),
        '--description',
        'The house style.',
      ],
      io,
    );

  it('adds a machine profile from the paths it is given, naming every file it writes', async () => {
    const io = testIo(box.home);

    expect(await addHouse(io)).toBe(0);

    const manifest = join(houseDir(box.home), 'profile.json');
    expect(await readJson(manifest)).toEqual({
      description: 'The house style.',
      standards: [join(docs, 'STANDARDS.md'), join(docs, 'PHILOSOPHY.md')],
      levels: { 'no-ternary': 3, 'max-lines': 2 },
    });
    expect(io.lines).toEqual([
      `Wrote ${manifest}`,
      'Make it active with npm run quarterdeck -- profile use house',
    ]);
    expect((await activeProfile({ homeDir: box.home })).name).toBe('default');
  });

  it('refuses a missing doc, a shipped name and an existing profile', async () => {
    const io = testIo(box.home);

    expect(
      await profile(['add', 'house', '--standards', join(docs, 'NOPE.md')], io),
    ).toBe(1);
    expect(
      await profile(
        ['add', 'default', '--standards', join(docs, 'STANDARDS.md')],
        io,
      ),
    ).toBe(1);
    expect(await addHouse(io)).toBe(0);
    expect(await addHouse(io)).toBe(1);
    expect(io.errors).toEqual([
      `${join(docs, 'NOPE.md')} does not exist`,
      'default is a shipped profile; pick another name',
      `${join(houseDir(box.home), 'profile.json')} exists; pass --force to replace it`,
    ]);
  });

  it('switches the machine to a profile and lists what each one reads', async () => {
    const io = testIo(box.home);
    await addHouse(io);

    expect(await profile(['use', 'house'], io)).toBe(0);
    expect(await readJson(machineChoice(box.home))).toEqual({
      profile: 'house',
    });
    expect((await profileKickoff({ homeDir: box.home })).standards).toBe(
      'House standard.\n\nHouse philosophy.',
    );

    const list = testIo(box.home);
    expect(await profile(['list'], list)).toBe(0);
    expect(list.lines).toContain(`* house (machine): The house style.`);
    expect(list.lines).toContain(`    ${join(docs, 'STANDARDS.md')}`);
    expect(list.lines).toContain('Active: house, chosen by this machine.');
    expect(list.lines).toContain(
      `npm run quarterdeck -- profile use <name> writes ${machineChoice(box.home)}.`,
    );
  });

  it('refuses to switch to a profile that does not exist', async () => {
    const io = testIo(box.home);

    expect(await profile(['use', 'nowhere'], io)).toBe(1);
    expect(io.errors[0]).toContain('no profile named nowhere');
  });

  it('chooses a profile for one project in its repo layer', async () => {
    const io = testIo(box.home);
    await addHouse(io);
    expect(await main(['init', box.repo], io)).toBe(0);

    expect(await profile(['use', 'house', '--project', SLUG], io)).toBe(0);

    const repoChoice = join(
      box.repo,
      '.quarterdeck',
      'rules.local.profile.json',
    );
    expect(await readJson(repoChoice)).toEqual({ profile: 'house' });
    expect(io.lines).toContain(`Wrote ${repoChoice}`);
    expect(
      (await activeProfile({ homeDir: box.home, repoDir: box.repo })).chosenBy,
    ).toBe('project');
    expect((await activeProfile({ homeDir: box.home })).name).toBe('default');
  });
});

describe('quarterdeck init with a rules profile', { timeout: TIMEOUT }, () => {
  let box: Sandbox;

  beforeEach(async () => {
    box = await sandbox();
    const dir = houseDir(box.home);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'profile.json'),
      JSON.stringify({
        description: 'The house style.',
        levels: { 'no-ternary': 3 },
        setup: {
          install: ['yarn', 'add', '-D', 'house-lint'],
          levelsFile: 'house.levels.json',
        },
      }),
    );
    await writeFile(
      machineChoice(box.home),
      JSON.stringify({ profile: 'house' }),
    );
  });

  afterEach(async () => {
    await box.close();
  });

  it('names what the setup writes, then installs, writes the levels and the steering block', async () => {
    const { io, ran } = recordingIo(box.home);

    expect(await main(['init', box.repo, '--setup'], io)).toBe(0);

    expect(ran).toEqual([
      { command: ['yarn', 'add', '-D', 'house-lint'], cwd: box.repo },
    ]);
    expect(await readJson(join(box.repo, 'house.levels.json'))).toEqual({
      rules: { 'no-ternary': 3 },
    });
    const agents = await readFile(join(box.repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('- `no-ternary`: 3, enforced and locked');
    expect(io.lines).toContain(
      'Rules profile house sets up the repository. It:',
    );
    expect(io.lines).toContain(
      `- writes the rule levels to ${join(box.repo, 'house.levels.json')}`,
    );
    expect(io.lines).toContain(
      `- writes the steering block into ${join(box.repo, 'AGENTS.md')}`,
    );
    expect(io.lines.at(-1)).toBe('Next: npm run quarterdeck -- up');
  });

  it('asks first, and writes nothing when the answer is no', async () => {
    const { io, ran } = recordingIo(box.home, ['', 'n']);

    expect(await main(['init', box.repo], io)).toBe(0);

    expect(io.questions.at(-1)).toBe('Set up the repository now? [y/N] ');
    expect(ran).toEqual([]);
    expect(await entries(box.repo)).toEqual(['.git']);
    expect(io.lines).toContain(
      `Skipped. Run it later with npm run quarterdeck -- profile setup ${box.repo}`,
    );
  });

  it('skips the setup without a terminal unless --setup is passed', async () => {
    const { io, ran } = recordingIo(box.home);

    expect(await main(['init', box.repo], io)).toBe(0);
    expect(ran).toEqual([]);
    expect(await entries(box.repo)).toEqual(['.git']);

    const later = recordingIo(box.home);
    expect(await profile(['setup', box.repo, '--yes'], later.io)).toBe(0);
    expect(later.ran).toHaveLength(1);
    expect(await entries(box.repo)).toEqual([
      '.git',
      'AGENTS.md',
      'house.levels.json',
    ]);
  });

  it('never sets anything up on the shipped default profile', async () => {
    await writeFile(
      machineChoice(box.home),
      JSON.stringify({ profile: 'default' }),
    );
    const { io, ran } = recordingIo(box.home);

    expect(await main(['init', box.repo, '--setup'], io)).toBe(0);

    expect(ran).toEqual([]);
    expect(await entries(box.repo)).toEqual(['.git']);
    expect(io.lines.some((line) => line.includes('Rules profile'))).toBe(false);
  });
});
