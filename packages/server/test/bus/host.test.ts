import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentNotFoundError } from '../../src/agents/index.js';
import {
  BUS_RELAY,
  BUS_SOCKET_ENV,
  BUS_TOKEN_ENV,
  busSocketPath,
  startBusHost,
  type BusHost,
} from '../../src/bus/index.js';
import type { Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  callTool,
  insertAgent,
  insertProject,
  openTestStore,
} from './fixtures.ts';

const connectStdio = async (launch: McpServerStdio): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: Object.fromEntries(launch.env.map(({ name, value }) => [name, value])),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bus-host-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
};

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
    host = await startBusHost({ store, socketPath: join(dir, 'bus.sock') });
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
        'read',
        'status',
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

  it('gives one agent the same token on every launch', async () => {
    const first = await host.launch(agentId);
    const second = await host.launch(agentId);

    expect(second.env).toEqual(first.env);
  });

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
    'cuts a revoked agent off and refuses its token afterwards',
    async () => {
      const launch = await host.launch(agentId);
      const client = await connectStdio(launch);
      clients.push(client);
      const closed = new Promise<void>((resolve) => {
        client.onclose = () => resolve();
      });

      host.revoke(agentId);

      await closed;
      const env = Object.fromEntries(
        launch.env.map(({ name, value }) => [name, value]),
      );
      expect((await runRelay(env)).stderr).toContain('denied');
    },
    TIMEOUT,
  );

  it('removes its socket on close', async () => {
    expect(existsSync(host.socketPath)).toBe(true);

    await host.close();

    expect(existsSync(host.socketPath)).toBe(false);
  });

  it('puts the socket next to the project data dir', () => {
    expect(busSocketPath('deck', '/home/q')).toBe('/home/q/deck/bus.sock');
  });
});
