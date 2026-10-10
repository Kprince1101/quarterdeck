import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REDACTED,
  createClaudeAdapter,
  type AcpClient,
  type AcpClientOptions,
  type PlannerAdapters,
  type RuntimeLaunch,
} from '../../src/index.js';
import {
  startQuarterdeck,
  type Quarterdeck,
} from '../../src/quarterdeck/index.js';
import {
  STORE_TABLES,
  quarterdeckHome,
  type Store,
} from '../../src/store/index.js';
import { fakeAgentLaunch } from '../acp/fake-agent/index.ts';
import {
  TIMEOUT,
  WAIT,
  createRepo,
  eventsOf,
  fakeGitHub,
  proposeTicket,
  sendIntent,
  storeOf,
  writeMachineRule,
} from './crew-fixtures.ts';

const PROJECT = 'example';
const KEY_PREFIX = 'sk-ant-';
const KEYCHAIN_KEY = `${KEY_PREFIX}api03-${'k'.repeat(48)}`;

const keyLaunches: RuntimeLaunch[] = [];

const claudeOnly = (processDir: string): PlannerAdapters => {
  const claude = createClaudeAdapter({
    processDir,
    auth: { readKeychain: async () => KEYCHAIN_KEY },
  });
  const connect = (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ): Promise<AcpClient> => {
    keyLaunches.push(launch);
    return claude.connect(
      {
        ...launch,
        command: fakeAgentLaunch({ crew: true, leaksApiKey: true }),
      },
      options,
    );
  };
  return { kiro: { connect }, claude: { connect }, gemini: { connect } };
};

const rowsWithKey = async (store: Store): Promise<string[]> => {
  const found: string[] = [];
  for (const table of STORE_TABLES) {
    const { rows } = await store.db.query<{ row: string }>(
      `select t::text as row from ${table} t where t::text like $1`,
      [`%${KEY_PREFIX}%`],
    );
    found.push(...rows.map(({ row }) => `${table}: ${row}`));
  }
  return found;
};

const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
};

const filesWithKey = async (dir: string): Promise<string[]> => {
  const files = await filesUnder(dir);
  const hits = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file);
      if (bytes.includes(KEY_PREFIX)) return [file];
      return [];
    }),
  );
  return hits.flat();
};

describe(
  'an api_key voyage keeps the key out of every store',
  { timeout: TIMEOUT },
  () => {
    let homeDir = '';
    const cleanup: (() => Promise<void>)[] = [];

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'qd-key-leak-'));
      const configDir = join(homeDir, 'claude-config');
      await mkdir(configDir);
      vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('QUARTERDECK_CLAUDE_AUTH', '');
      await writeMachineRule(homeDir, 'lifecycle.json', {
        autoEndSettleSeconds: 1,
        mergeGate: { autoMerge: false },
      });
      await writeFile(
        join(quarterdeckHome(homeDir), 'claude.json'),
        JSON.stringify({ auth: 'api_key' }),
      );
    });

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
      vi.unstubAllEnvs();
      keyLaunches.splice(0);
      await rm(homeDir, { recursive: true, force: true });
    });

    it('runs a ticket end to end with the Keychain key while every agent tries to leak it', async () => {
      let qd: Quarterdeck | undefined = await startQuarterdeck({
        port: 0,
        homeDir,
        adapters: claudeOnly(join(homeDir, 'claude-runtime')),
        forge: fakeGitHub(),
      });
      const close = async () => {
        await qd?.close();
        qd = undefined;
      };
      cleanup.push(close);
      const repo = await createRepo();
      cleanup.push(() => rm(repo, { recursive: true, force: true }));
      expect(
        (
          await sendIntent(qd, 'project.create', {
            project: PROJECT,
            repoPath: repo,
          })
        ).status,
      ).toBe(200);
      const store = storeOf(qd, PROJECT);

      expect(
        (await sendIntent(qd, 'voyage.start', { goal: 'Ship it' })).status,
      ).toBe(200);
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'driver.voyage_started')).toHaveLength(1);
      }, WAIT);
      const ticket = await proposeTicket(store, 'Add a greeting');
      expect(
        (
          await sendIntent(qd, 'ticket.approve', {
            project: PROJECT,
            ticketId: ticket,
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'ticket.verdict')).toEqual([
          expect.objectContaining({
            ticketId: ticket,
            payload: expect.objectContaining({ decision: 'approve' }),
          }),
        ]);
      }, WAIT);

      expect(keyLaunches.length).toBeGreaterThanOrEqual(3);
      expect(await eventsOf(store, 'agent.status')).toContainEqual(
        expect.objectContaining({ payload: { text: `Working ${REDACTED}` } }),
      );
      expect(await rowsWithKey(store)).toEqual([]);

      await close();
      expect(await filesWithKey(quarterdeckHome(homeDir))).toEqual([]);
    });
  },
);
