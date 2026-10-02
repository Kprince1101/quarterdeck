import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openStore } from '../../src/store/index.js';
import {
  TicketSourceError,
  TicketSourceInputError,
  TicketSourcePluginError,
  loadTicketSource,
  openTicketSource,
  ticketPluginPath,
  ticketPluginsDir,
} from '../../src/tickets/index.js';

const CALLS = '__quarterdeckTicketPluginCalls';

const RECORDING_PLUGIN = `
export default ({ name, project }) => {
  const calls = (globalThis.${CALLS} ??= []);
  calls.push(['create', name, project]);
  return {
    listApproved: async () => [
      { ref: 'EXT-1', title: ' Widget ', body: 'Build it.' },
      { ref: 'EXT-2', title: 'Gadget' },
    ],
    setStatus: async (ref, status) => { calls.push(['setStatus', ref, status]); },
    note: async (ref, body) => { calls.push(['note', ref, body]); },
    attachPr: async (ref, pr) => { calls.push(['attachPr', ref, pr]); },
  };
};
`;

const methods = (overrides: string): string => `
export default () => ({
  listApproved: async () => [],
  setStatus: async () => {},
  note: async () => {},
  attachPr: async () => {},
  ${overrides}
});
`;

const calls = (): unknown[] =>
  ((globalThis as Record<string, unknown>)[CALLS] as unknown[] | undefined) ??
  [];

describe('ticket-source plugins', () => {
  let root: string;
  let home: string;
  let plugins: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qd-plugins-')));
    home = join(root, '.quarterdeck');
    plugins = ticketPluginsDir(home);
    await mkdir(plugins, { recursive: true });
    delete (globalThis as Record<string, unknown>)[CALLS];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writePlugin = (name: string, source: string): Promise<void> =>
    writeFile(join(plugins, `${name}.mjs`), source);

  it('lives in ~/.quarterdeck/plugins/<name>.mjs', () => {
    expect(ticketPluginsDir()).toBe(join(homedir(), '.quarterdeck', 'plugins'));
    expect(ticketPluginPath('tracker')).toBe(
      join(homedir(), '.quarterdeck', 'plugins', 'tracker.mjs'),
    );
    expect(ticketPluginPath('tracker', '/tmp/qd')).toBe(
      '/tmp/qd/plugins/tracker.mjs',
    );
  });

  it('loads a plugin and passes calls through', async () => {
    await writePlugin('tracker', RECORDING_PLUGIN);
    const source = await loadTicketSource('tracker', { project: 'deck', home });
    expect(source.name).toBe('tracker');
    expect(await source.listApproved()).toEqual([
      { ref: 'EXT-1', title: 'Widget', body: 'Build it.' },
      { ref: 'EXT-2', title: 'Gadget', body: '' },
    ]);
    await source.setStatus('EXT-1', 'in_review');
    await source.note('EXT-1', ' Reviewing. ');
    await source.attachPr('EXT-1', { url: 'https://x.test/pr/3', head: null });
    expect(calls()).toEqual([
      ['create', 'tracker', 'deck'],
      ['setStatus', 'EXT-1', 'in_review'],
      ['note', 'EXT-1', 'Reviewing.'],
      ['attachPr', 'EXT-1', { url: 'https://x.test/pr/3', head: null }],
    ]);
  });

  it('opens the named plugin instead of the tickets table', async () => {
    await writePlugin('tracker', RECORDING_PLUGIN);
    const store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
    try {
      const source = await openTicketSource(store, {
        project: 'deck',
        plugin: 'tracker',
        home,
      });
      expect(source.name).toBe('tracker');
    } finally {
      await store.close();
    }
  }, 30_000);

  it('checks arguments before they reach the plugin', async () => {
    await writePlugin('tracker', RECORDING_PLUGIN);
    const source = await loadTicketSource('tracker', { project: 'deck', home });
    await expect(
      source.setStatus('EXT-1', 'shipped' as 'done'),
    ).rejects.toBeInstanceOf(TicketSourceInputError);
    await expect(source.note('', 'hi')).rejects.toBeInstanceOf(
      TicketSourceInputError,
    );
    expect(calls()).toEqual([['create', 'tracker', 'deck']]);
  });

  it.each(['../escape', 'a/b', 'Upper', '', 'x'.repeat(64), 'local'])(
    'refuses the plugin name %j',
    async (name) => {
      await expect(
        loadTicketSource(name, { project: 'deck', home }),
      ).rejects.toBeInstanceOf(TicketSourcePluginError);
    },
  );

  it('refuses a plugin that is not there', async () => {
    await expect(
      loadTicketSource('tracker', { project: 'deck', home }),
    ).rejects.toThrow(`there is no file ${join(plugins, 'tracker.mjs')}`);
  });

  it('refuses when there is no plugins folder', async () => {
    await rm(plugins, { recursive: true });
    await expect(
      loadTicketSource('tracker', { project: 'deck', home }),
    ).rejects.toThrow(`there is no folder ${plugins}`);
  });

  it('refuses a plugin that resolves outside the plugins folder', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'tracker.mjs'), RECORDING_PLUGIN);
    await symlink(join(repo, 'tracker.mjs'), join(plugins, 'tracker.mjs'));
    await expect(
      loadTicketSource('tracker', { project: 'deck', home }),
    ).rejects.toThrow('outside');
    expect(calls()).toEqual([]);
  });

  it.each([
    ['a module that does not parse', 'export default ('],
    ['no default export', 'export const x = 1;'],
    ['a default export that is not a function', 'export default {};'],
    [
      'a default export that throws',
      'export default () => { throw new Error("no token"); };',
    ],
    ['a default export that returns nothing', 'export default () => null;'],
    [
      'a missing method',
      'export default () => ({ listApproved: async () => [] });',
    ],
  ])('refuses %s', async (_, source) => {
    await writePlugin('broken', source);
    await expect(
      loadTicketSource('broken', { project: 'deck', home }),
    ).rejects.toBeInstanceOf(TicketSourcePluginError);
  });

  it('names a missing method', async () => {
    await writePlugin(
      'partial',
      'export default () => ({ listApproved: async () => [], note: async () => {} });',
    );
    await expect(
      loadTicketSource('partial', { project: 'deck', home }),
    ).rejects.toThrow('it has no setStatus, attachPr function');
  });

  it('turns what a plugin throws into a TicketSourceError', async () => {
    await writePlugin(
      'failing',
      methods(
        `setStatus: async () => { throw new Error('tracker is down'); },`,
      ),
    );
    const source = await loadTicketSource('failing', { project: 'deck', home });
    const failure = source.setStatus('EXT-1', 'done');
    await expect(failure).rejects.toBeInstanceOf(TicketSourceError);
    await expect(failure).rejects.toThrow(
      'Ticket source failing failed setStatus: tracker is down',
    );
  });

  it.each([
    ['not a list', 'listApproved: async () => ({}),'],
    [
      'a ticket with no title',
      "listApproved: async () => [{ ref: 'A', title: ' ' }],",
    ],
    ['a ticket with no ref', "listApproved: async () => [{ title: 'A' }],"],
    [
      'one ref twice',
      "listApproved: async () => [{ ref: 'A', title: 'A' }, { ref: 'A', title: 'B' }],",
    ],
  ])('refuses a listing that is %s', async (_, override) => {
    await writePlugin('lister', methods(override));
    const source = await loadTicketSource('lister', { project: 'deck', home });
    await expect(source.listApproved()).rejects.toBeInstanceOf(
      TicketSourceError,
    );
  });
});
