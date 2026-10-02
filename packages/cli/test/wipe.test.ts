import { join } from 'node:path';
import {
  createProjectStores,
  quarterdeckHome,
  recordAgentProcess,
} from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIPE_USAGE, main, type CliIo } from '../src/index.js';
import { entries, sandbox, testIo, type Sandbox } from './harness.js';

vi.mock(
  '../../server/src/acp/client/process-start.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../server/src/acp/client/process-start.js')
    >()),
    stopOwnTree: () => Promise.resolve('unverified'),
  }),
);

const TIMEOUT = 30_000;

const wipe = (args: string[], io: CliIo) => main(['wipe', ...args], io);

const init = async (box: Sandbox, project: string) => {
  const io = testIo(box.home);
  expect(await main(['init', box.repo, '--project', project], io)).toBe(0);
};

const projects = (home: string) => entries(quarterdeckHome(home));

const addAgent = async (
  home: string,
  project: string,
  name: string,
  pid?: number,
) => {
  const stores = createProjectStores(quarterdeckHome(home));
  try {
    const store = await stores.get(project);
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, 'builder', 'working') returning id`,
      [store.projectId, name],
    );
    const id = rows[0]?.id ?? '';
    if (pid !== undefined) {
      await recordAgentProcess(store.db, id, { pid, startedAt: new Date() });
    }
  } finally {
    await stores.closeAll();
  }
};

describe('quarterdeck wipe', { timeout: TIMEOUT }, () => {
  let box: Sandbox;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.close();
  });

  it('asks for the slug, then stops the agents and deletes the project', async () => {
    await init(box, 'deck');
    await init(box, 'other');
    await addAgent(box.home, 'deck', 'wren');
    const io = testIo(box.home, ['deck']);

    expect(await wipe(['deck'], io)).toBe(0);

    expect(io.questions).toEqual(['Type deck to wipe: ']);
    expect(io.lines).toEqual([
      `This stops deck's agents and deletes everything Quarterdeck stores for it in ${join(quarterdeckHome(box.home), 'deck')}.`,
      'Wiped deck. Stopped wren (deck) first.',
    ]);
    expect(await projects(box.home)).toEqual(['other']);
  });

  it('wipes nothing when the typed name does not match', async () => {
    await init(box, 'deck');
    const io = testIo(box.home, ['dec']);

    expect(await wipe(['deck'], io)).toBe(1);

    expect(io.errors).toEqual([
      'Nothing wiped: the confirmation must be deck.',
    ]);
    expect(await projects(box.home)).toEqual(['deck']);
  });

  it('takes --confirm without a terminal', async () => {
    await init(box, 'deck');
    const io = testIo(box.home);

    expect(await wipe(['deck', '--confirm', 'deck'], io)).toBe(0);

    expect(io.lines).toEqual(['Wiped deck.']);
    expect(await projects(box.home)).toEqual([]);
  });

  it('refuses without a terminal or --confirm', async () => {
    await init(box, 'deck');
    const io = testIo(box.home);

    expect(await wipe(['deck'], io)).toBe(1);

    expect(io.errors).toEqual([
      'Nothing wiped. Without a terminal, pass --confirm deck.',
    ]);
    expect(await projects(box.home)).toEqual(['deck']);
  });

  it('refuses a wrong --confirm', async () => {
    await init(box, 'deck');
    const io = testIo(box.home);

    expect(await wipe(['deck', '--confirm', 'other'], io)).toBe(1);

    expect(io.errors).toEqual([
      'Nothing wiped: the confirmation must be deck.',
    ]);
    expect(await projects(box.home)).toEqual(['deck']);
  });

  it('with --all asks for the phrase and wipes every project', async () => {
    await init(box, 'deck');
    await init(box, 'other');
    const io = testIo(box.home, ['wipe everything']);

    expect(await wipe(['--all'], io)).toBe(0);

    expect(io.questions).toEqual(['Type "wipe everything" to wipe: ']);
    expect(io.lines).toEqual([
      `This stops every agent and deletes every project in ${quarterdeckHome(box.home)}: deck, other.`,
      'Wiped deck, other.',
    ]);
    expect(await projects(box.home)).toEqual([]);
  });

  it('with --all takes --confirm "wipe everything" without a terminal', async () => {
    await init(box, 'deck');
    const io = testIo(box.home);

    expect(await wipe(['--all', '--confirm', 'wipe everything'], io)).toBe(0);

    expect(io.lines).toEqual(['Wiped deck.']);
  });

  it('with --all says so when there is nothing to wipe', async () => {
    const io = testIo(box.home);
    expect(await wipe(['--all'], io)).toBe(0);
    expect(io.lines).toEqual([
      `Nothing to wipe in ${quarterdeckHome(box.home)}.`,
    ]);
  });

  it('keeps the project with a 409 message when a process cannot be confirmed stopped', async () => {
    await init(box, 'deck');
    await addAgent(box.home, 'deck', 'wren', 4242);
    const io = testIo(box.home);

    expect(await wipe(['deck', '--confirm', 'deck'], io)).toBe(1);

    expect(io.errors).toEqual([
      'could not confirm that wren stopped; deck is kept so the next start sweeps them',
    ]);
    expect(await projects(box.home)).toEqual(['deck']);
  });

  it('refuses while another process has the project open', async () => {
    await init(box, 'deck');
    const stores = createProjectStores(quarterdeckHome(box.home));
    try {
      await stores.get('deck');
      const io = testIo(box.home);

      expect(await wipe(['deck', '--confirm', 'deck'], io)).toBe(1);

      expect(io.errors[0]).toContain('project deck is already open');
    } finally {
      await stores.closeAll();
    }
    expect(await projects(box.home)).toEqual(['deck']);
  });

  it('names a project that does not exist', async () => {
    const io = testIo(box.home, ['deck']);
    expect(await wipe(['deck'], io)).toBe(1);
    expect(io.errors).toEqual([
      `project deck does not exist in ${quarterdeckHome(box.home)}`,
    ]);
    expect(io.questions).toEqual([]);
  });

  it.each([
    [[], 'wipe needs a project or --all'],
    [['deck', '--all'], 'Pass a project or --all, not both'],
    [['a', 'b'], 'wipe takes one project'],
    [['Not A Slug'], '"Not A Slug" is not a project slug'],
    [['--yes'], "Unknown option '--yes'"],
  ])('fails cleanly on %j', async (args, message) => {
    const io = testIo(box.home);
    expect(await wipe(args, io)).toBe(1);
    expect(io.errors.join('\n')).toContain(message);
  });

  it('prints its usage', async () => {
    const io = testIo(box.home);
    expect(await wipe(['--help'], io)).toBe(0);
    expect(io.lines).toEqual([WIPE_USAGE]);
  });
});
