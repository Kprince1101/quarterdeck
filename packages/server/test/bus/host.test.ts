import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentNotFoundError } from '../../src/agents/index.js';
import {
  BUS_RELAY,
  BUS_SOCKET_ENV,
  BUS_TOKEN_ENV,
  SOCKET_PATH_MAX,
  busSocketPath,
  startBusHost,
  type BusHost,
} from '../../src/bus/index.js';
import { openStore, type Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  callTool,
  connectStdio,
  envOf,
  insertAgent,
  insertProject,
  openTestStore,
} from './fixtures.ts';

interface RelayExit {
  status: number | null;
  stderr: string;
}

const runRelay = (env: Record<string, string>): Promise<RelayExit> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUS_RELAY], { env });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });

describe('bus host', () => {
  let dir = '';
  let store: Store;
  let host: BusHost;
  let agentId = '';
  const clients: Client[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qd-bus-'));
    store = await openTestStore('hosted');
    agentId = await insertAgent(store, store.projectId, 'okapi');
    host = await startBusHost({ store, home: dir });
  }, TIMEOUT);

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await host.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'serves the bus tools to a session over the stdio relay',
    async () => {
      const launch = await host.launch(agentId);
      expect(launch).toMatchObject({
        name: 'bus',
        command: process.execPath,
        args: [BUS_RELAY],
      });
      const client = await connectStdio(launch);
      clients.push(client);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual([
        'ask',
        'propose',
        'read',
        'report',
        'status',
        'verdict',
      ]);
      expect(await callTool(client, 'status', { text: 'over stdio' })).toEqual({
        text: 'noted',
        isError: false,
      });
      const read = await callTool(client, 'read', {
        table: 'events',
        columns: ['agent_id', 'kind', 'payload'],
      });
      expect(JSON.parse(read.text)).toEqual([
        {
          agent_id: agentId,
          kind: 'agent.status',
          payload: { text: 'over stdio' },
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    'keeps sessions of different agents apart',
    async () => {
      const otherId = await insertAgent(store, store.projectId, 'quetzal');
      const mine = await connectStdio(await host.launch(agentId));
      const theirs = await connectStdio(await host.launch(otherId));
      clients.push(mine, theirs);

      await callTool(mine, 'status', { text: 'mine' });
      await callTool(theirs, 'status', { text: 'theirs' });

      const { rows } = await store.db.query<{ agent_id: string; text: string }>(
        `select agent_id, payload->>'text' as text from events
         where kind = 'agent.status' order by id`,
      );
      expect(rows).toEqual([
        { agent_id: agentId, text: 'mine' },
        { agent_id: otherId, text: 'theirs' },
      ]);
    },
    TIMEOUT,
  );

  it(
    'takes each token once and only the latest one per agent',
    async () => {
      const first = await host.launch(agentId);
      const second = await host.launch(agentId);
      expect(envOf(second)[BUS_TOKEN_ENV]).not.toBe(
        envOf(first)[BUS_TOKEN_ENV],
      );

      expect((await runRelay(envOf(first))).stderr).toContain('denied');
      const client = await connectStdio(second);
      clients.push(client);
      expect(await callTool(client, 'status', { text: 'pinned' })).toEqual({
        text: 'noted',
        isError: false,
      });
      expect((await runRelay(envOf(second))).stderr).toContain('denied');
    },
    TIMEOUT,
  );

  it('refuses to launch for an agent outside the project or retired', async () => {
    const other = await insertProject(store, 'elsewhere');
    const stranger = await insertAgent(store, other, 'stranger');
    await store.db.query(`update agents set status = 'retired' where id = $1`, [
      agentId,
    ]);

    await expect(host.launch(stranger)).rejects.toThrow(AgentNotFoundError);
    await expect(host.launch(agentId)).rejects.toThrow(AgentNotFoundError);
  });

  it(
    'turns away a relay with an unknown token',
    async () => {
      const result = await runRelay({
        [BUS_SOCKET_ENV]: host.socketPath,
        [BUS_TOKEN_ENV]: 'not-a-token',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the bus refused this session (denied)');
    },
    TIMEOUT,
  );

  it(
    'exits with a message when the relay is not configured',
    async () => {
      const result = await runRelay({});

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'QUARTERDECK_BUS_SOCKET and QUARTERDECK_BUS_TOKEN must be set',
      );
    },
    TIMEOUT,
  );

  it(
    'cuts a revoked agent off and refuses its pending token',
    async () => {
      const client = await connectStdio(await host.launch(agentId));
      clients.push(client);
      const pending = await host.launch(agentId);
      const closed = new Promise<void>((resolve) => {
        client.onclose = () => resolve();
      });

      host.revoke(agentId);

      await closed;
      expect((await runRelay(envOf(pending))).stderr).toContain('denied');
    },
    TIMEOUT,
  );

  it('listens under <home>/sock in a private dir and removes the socket on close', async () => {
    expect(host.socketPath).toBe(busSocketPath(store.projectId, { home: dir }));
    expect(host.socketPath.startsWith(join(dir, 'sock'))).toBe(true);
    expect((await stat(dirname(host.socketPath))).mode & 0o777).toBe(0o700);
    expect(existsSync(host.socketPath)).toBe(true);

    await host.close();

    expect(existsSync(host.socketPath)).toBe(false);
  });

  it('refuses an explicit socket path longer than the limit', async () => {
    const socketPath = join(dir, 'x'.repeat(SOCKET_PATH_MAX), 'bus.sock');

    await expect(startBusHost({ store, socketPath })).rejects.toThrow(
      `the limit is ${SOCKET_PATH_MAX}`,
    );
  });

  it.each([0, 1.5, 2 ** 31])(
    'refuses an ask expiry of %s ms',
    async (askExpiryMs) => {
      await expect(
        startBusHost({ store, home: dir, askExpiryMs }),
      ).rejects.toThrow('askExpiryMs must be an integer');
    },
  );

  it(
    'expires ask cards after askExpiryMs',
    async () => {
      await host.close();
      host = await startBusHost({ store, home: dir, askExpiryMs: 100 });
      const client = await connectStdio(await host.launch(agentId));
      clients.push(client);

      const reply = await callTool(client, 'ask', {
        question: 'Ship it?',
        options: ['yes', 'no'],
        checked: 'CI is green.',
        recommendation: 'yes',
      });

      expect(JSON.parse(reply.text)).toMatchObject({
        status: 'expired',
        answer: null,
      });
    },
    TIMEOUT,
  );
});

describe('bus host for a long slug under a long home', () => {
  let home = '';

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'qd-bus-home-'));
    home = join(base, 'h'.repeat(60), 'quarterdeck-home-with-a-long-name');
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(dirname(dirname(home)), { recursive: true, force: true });
  });

  it(
    'listens on a short socket and relays a session',
    async () => {
      const slug = 'a'.repeat(63);
      expect(Buffer.byteLength(join(home, slug, 'bus.sock'))).toBeGreaterThan(
        SOCKET_PATH_MAX,
      );
      const store = await openStore({ project: slug, home });
      const host = await startBusHost({ store, home });
      try {
        expect(Buffer.byteLength(host.socketPath)).toBeLessThanOrEqual(
          SOCKET_PATH_MAX,
        );
        expect(host.socketPath.startsWith(home)).toBe(false);
        expect((await stat(dirname(host.socketPath))).mode & 0o777).toBe(0o700);
        const agentId = await insertAgent(store, store.projectId, 'okapi');
        const client = await connectStdio(await host.launch(agentId));
        try {
          expect(await callTool(client, 'status', { text: 'long' })).toEqual({
            text: 'noted',
            isError: false,
          });
        } finally {
          await client.close();
        }
      } finally {
        await host.close();
        await store.close();
      }
    },
    TIMEOUT,
  );
});
