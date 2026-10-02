import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApiServer, type ApiServer } from '../../src/api/index.js';
import { giveProcess } from '../lifecycle/fixtures.js';
import { insertAgent, lenientSessions } from '../round-end/fixtures.js';
import { fakeWorktrees } from '../agents/fixtures.js';
import { TIMEOUT } from './harness.js';

vi.mock('../../src/acp/client/process-start.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/acp/client/process-start.js')
  >()),
  stopOwnTree: () => Promise.resolve('unverified'),
}));

describe(
  'a wipe that cannot confirm a process stopped',
  { timeout: TIMEOUT },
  () => {
    let homeDir: string;
    let api: ApiServer;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'qd-wipe-'));
      api = await startApiServer({
        port: 0,
        homeDir,
        databaseUrl: '',
        stopHosts: { sessions: lenientSessions(), worktrees: fakeWorktrees() },
      });
    }, TIMEOUT);

    afterEach(async () => {
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

    it('keeps the project, so the next start sweeps it', async () => {
      expect((await send('project.create', { project: 'deck' })).status).toBe(
        200,
      );
      const store = await api.stores.get('deck');
      const agentId = await insertAgent(store, {
        name: 'wren',
        status: 'working',
      });
      await giveProcess(store, agentId, { pid: 4242, startedAt: new Date() });

      const res = await send('wipe.project', {
        project: 'deck',
        confirm: 'deck',
      });

      expect(res.status).toBe(409);
      expect(res.body['error']).toBe(
        'could not confirm that wren stopped; deck is kept so the next start sweeps them',
      );
      expect(existsSync(join(homeDir, '.quarterdeck', 'deck'))).toBe(true);
      const { rows } = await store.db.query<{ pid: number }>(
        'select pid from agents where id = $1',
        [agentId],
      );
      expect(rows).toEqual([{ pid: 4242 }]);
    });
  },
);
