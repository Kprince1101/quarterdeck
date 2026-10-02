import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServer } from '../../src/api/index.js';
import { WIPE_ALL_CONFIRMATION } from '../../src/intents/index.js';
import { fakeWorktrees, type FakeWorktrees } from '../agents/fixtures.js';
import {
  GRACE_MS,
  IS_WINDOWS,
  exitOf,
  giveProcess,
  startSleeper,
  stopSleepers,
} from '../lifecycle/fixtures.js';
import { insertAgent, lenientSessions } from '../round-end/fixtures.js';
import { TIMEOUT } from './harness.js';

describe('wipe stops the agents first', { timeout: TIMEOUT }, () => {
  let homeDir: string;
  let api: ApiServer;
  let sessions: ReturnType<typeof lenientSessions>;
  let worktrees: FakeWorktrees;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-wipe-'));
    sessions = lenientSessions();
    worktrees = fakeWorktrees();
    api = await startApiServer({
      port: 0,
      homeDir,
      databaseUrl: '',
      stopHosts: { sessions, worktrees, killGraceMs: GRACE_MS },
    });
  }, TIMEOUT);

  afterEach(async () => {
    stopSleepers();
    await api.close();
    await rm(homeDir, { recursive: true, force: true });
  });

  const send = async (name: string, body: unknown) => {
    const res = await fetch(`${api.url}/api/intents/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };

  const projectDir = (project: string) =>
    join(homeDir, '.quarterdeck', project);

  const createWithAgent = async (project: string, name: string) => {
    expect((await send('project.create', { project })).status).toBe(200);
    const store = await api.stores.get(project);
    const agentId = await insertAgent(store, {
      name,
      status: 'working',
      sessionId: `session-${name}`,
      worktreePath: join(projectDir(project), 'worktrees', name),
    });
    return { store, agentId };
  };

  it.skipIf(IS_WINDOWS)(
    'wipe.project kills its agents and their processes, then deletes it',
    async () => {
      const sleeper = await startSleeper();
      const { store, agentId } = await createWithAgent('deck', 'wren');
      await giveProcess(store, agentId, sleeper);

      const res = await send('wipe.project', {
        project: 'deck',
        confirm: 'deck',
      });

      expect(res.status).toBe(200);
      expect(res.body['result']).toEqual({
        wiped: ['deck'],
        stopped: [{ project: 'deck', agent: 'wren' }],
      });
      expect(await exitOf(sleeper)).toEqual([null, 'SIGTERM']);
      expect(sessions.closed).toEqual(['session-wren']);
      expect(worktrees.removed).toEqual([
        { path: join(projectDir('deck'), 'worktrees', 'wren'), force: true },
      ]);
      expect(existsSync(projectDir('deck'))).toBe(false);
    },
  );

  it('wipe.all stops the agents of every project', async () => {
    await createWithAgent('deck', 'wren');
    await createWithAgent('yard', 'lark');

    const res = await send('wipe.all', { confirm: WIPE_ALL_CONFIRMATION });

    expect(res.status).toBe(200);
    expect(res.body['result']).toEqual({
      wiped: ['deck', 'yard'],
      stopped: [
        { project: 'deck', agent: 'wren' },
        { project: 'yard', agent: 'lark' },
      ],
    });
    expect(sessions.closed).toEqual(['session-wren', 'session-lark']);
    expect(existsSync(projectDir('deck'))).toBe(false);
    expect(existsSync(projectDir('yard'))).toBe(false);
  });
});
