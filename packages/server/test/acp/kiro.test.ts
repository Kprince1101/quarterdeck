import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agent,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type { AnyMessage, McpServer, Stream } from '@agentclientprotocol/sdk';
import {
  AcpClientError,
  connectAcpClient,
  createKiroAdapter,
  KIRO_ADAPTER,
  KIRO_EXTENSION_NOTIFICATIONS,
  kiroAgentConfigPath,
  KiroConfigError,
  subscribeKiroEvents,
  toKiroEvent,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  AcpClientOptions,
  KiroEvent,
} from '@quarterdeck/server';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeAgentLaunch } from './fake-agent/launch.ts';
import { describeRuntimeConformance } from './runtime-conformance.ts';

const agentsDir = mkdtempSync(join(tmpdir(), 'quarterdeck-kiro-agents-'));
const adapter = createKiroAdapter({ agentsDir });

afterAll(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

const clientOptions = (
  overrides: Partial<AcpClientOptions> = {},
): AcpClientOptions => ({
  clientName: 'quarterdeck-kiro-test',
  clientVersion: '0.0.0',
  onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  ...overrides,
});

const BUS: McpServer = {
  name: 'bus',
  command: '/usr/local/bin/quarterdeck-bus',
  args: ['--agent', 'narwhal'],
  env: [{ name: 'QUARTERDECK_PROJECT', value: 'deck' }],
};

const DOCS: McpServer = {
  type: 'http',
  name: 'docs',
  url: 'https://docs.example/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer x' }],
};

const EVENTS: McpServer = {
  type: 'sse',
  name: 'events',
  url: 'https://events.example/sse',
  headers: [],
};

const SEARCH: McpServer = {
  name: 'search',
  command: '/usr/local/bin/search-mcp',
  args: [],
  env: [],
};

const configPath = (name: string) =>
  kiroAgentConfigPath(agentsDir, `quarterdeck-${name}`);

const agentText = (events: AcpClientEvent[]): string =>
  events
    .flatMap((event) => {
      if (event.type !== 'session_update') return [];
      const { update } = event;
      if (update.sessionUpdate !== 'agent_message_chunk') return [];
      if (update.content.type !== 'text') return [];
      return [update.content.text];
    })
    .join('');

describeRuntimeConformance(adapter, { agentName: 'conformance' });

describe('kiro command', () => {
  it('runs kiro-cli acp with the per-agent config', () => {
    expect(
      KIRO_ADAPTER.command({
        cwd: '/work/deck',
        agentName: 'narwhal',
        env: { PATH: '/bin' },
      }),
    ).toEqual({
      command: 'kiro-cli',
      args: ['acp', '--agent', 'quarterdeck-narwhal'],
      cwd: '/work/deck',
      env: { PATH: '/bin' },
    });
  });

  it('is the kiro runtime', () => {
    expect(KIRO_ADAPTER.runtime).toBe('kiro');
    expect(KIRO_ADAPTER.displayName).toBe('Kiro');
  });

  it.each(['', '../escape', 'a/b', '-flag'])(
    'refuses agent name %j',
    (agentName) => {
      expect(() => KIRO_ADAPTER.command({ cwd: '/w', agentName })).toThrow(
        KiroConfigError,
      );
    },
  );

  it('refuses a launch with no agent name', async () => {
    expect(() => KIRO_ADAPTER.command({ cwd: '/w' })).toThrow(KiroConfigError);
    await expect(
      adapter.connect(
        { cwd: tmpdir(), command: fakeAgentLaunch() },
        clientOptions(),
      ),
    ).rejects.toBeInstanceOf(KiroConfigError);
  });
});

describe('kiro agent config', () => {
  it('writes the bus MCP into the agent config and removes it on close', async () => {
    const events: AcpClientEvent[] = [];
    const client = await adapter.connect(
      {
        cwd: tmpdir(),
        agentName: 'narwhal',
        mcpServers: [BUS, DOCS, EVENTS],
        command: fakeAgentLaunch(),
      },
      clientOptions({ onEvent: (event) => events.push(event) }),
    );
    const path = configPath('narwhal');
    try {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        name: 'quarterdeck-narwhal',
        description:
          'Quarterdeck agent. Written by Quarterdeck, removed on close.',
        mcpServers: {
          bus: {
            command: '/usr/local/bin/quarterdeck-bus',
            args: ['--agent', 'narwhal'],
            env: { QUARTERDECK_PROJECT: 'deck' },
          },
          docs: {
            type: 'http',
            url: 'https://docs.example/mcp',
            headers: { Authorization: 'Bearer x' },
          },
        },
        tools: ['*'],
        allowedTools: [],
        includeMcpJson: false,
      });

      const { sessionId } = await client.newSession({
        cwd: tmpdir(),
        mcpServers: [BUS, DOCS, EVENTS, SEARCH],
      });
      await client.prompt(sessionId, 'describe_session');
      expect(JSON.parse(agentText(events))).toEqual({
        cwd: tmpdir(),
        mcpServers: ['events', 'search'],
      });
    } finally {
      await client.close();
    }
    expect(existsSync(path)).toBe(false);
  });

  it('removes the config when the agent fails to start', async () => {
    await expect(
      adapter.connect(
        {
          cwd: tmpdir(),
          agentName: 'nostart',
          command: { command: join(agentsDir, 'missing-kiro-cli'), args: [] },
        },
        clientOptions(),
      ),
    ).rejects.toBeInstanceOf(AcpClientError);
    expect(existsSync(configPath('nostart'))).toBe(false);
  });

  it('removes the config when the agent exits on its own', async () => {
    const client = await adapter.connect(
      { cwd: tmpdir(), agentName: 'crasher', command: fakeAgentLaunch() },
      clientOptions(),
    );
    const { sessionId } = await client.newSession({
      cwd: tmpdir(),
      mcpServers: [],
    });
    await client.prompt(sessionId, 'crash').catch(() => undefined);
    await client.closed;
    expect(existsSync(configPath('crasher'))).toBe(false);
    await client.close();
  });
});

const KIRO_NOTIFICATIONS: [string, Record<string, unknown>][] = [
  [
    '_kiro.dev/commands/available',
    { sessionId: 's1', commands: [{ name: '/context' }] },
  ],
  [
    '_kiro.dev/mcp/oauth_request',
    { serverName: 'docs', url: 'https://auth.example/x' },
  ],
  ['_kiro.dev/mcp/server_initialized', { serverName: 'bus' }],
  ['_kiro.dev/compaction/status', { sessionId: 's1', status: 'started' }],
  [
    '_kiro.dev/clear/status',
    { sessionId: 's1', status: { type: 'completed' } },
  ],
  ['_kiro.dev/metadata', { sessionId: 's1', contextUsagePercentage: 42.5 }],
  ['_kiro.dev/agent/switched', { agentName: 'other' }],
  ['_session/terminate', { sessionId: 'sub-1' }],
  ['_other.dev/ignored', { sessionId: 's1' }],
];

const kiroLikeAgent = (): Stream => {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  agent({ name: 'kiro-like' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest('session/new', () => ({ sessionId: 's1' }))
    .onRequest('session/prompt', async ({ client }) => {
      for (const [method, params] of KIRO_NOTIFICATIONS) {
        await client.notify(method, params);
      }
      await client.notify('_kiro.dev/metadata', 'not an object');
      const token = await client.request('_kiro/auth/getAccessToken', {}).then(
        () => 'served',
        (err: unknown) => {
          if (err instanceof RequestError) return err.code;
          return 'error';
        },
      );
      await client.notify('session/update', {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `token request: ${token}` },
        },
      });
      return { stopReason: 'end_turn' };
    })
    .connect({ readable: toAgent.readable, writable: toClient.writable });
  return { readable: toClient.readable, writable: toAgent.writable };
};

describe('kiro extension methods', () => {
  const connectKiroLike = (): Promise<AcpClient> =>
    connectAcpClient({
      stream: kiroLikeAgent(),
      options: clientOptions({
        extensionNotifications: KIRO_EXTENSION_NOTIFICATIONS,
      }),
    });

  it('maps every Kiro notification to a Kiro event', async () => {
    const client = await connectKiroLike();
    const kiroEvents: KiroEvent[] = [];
    subscribeKiroEvents(client, (event) => kiroEvents.push(event));
    try {
      const { sessionId } = await client.newSession({
        cwd: tmpdir(),
        mcpServers: [],
      });
      await client.prompt(sessionId, 'go');
    } finally {
      await client.close();
    }
    expect(kiroEvents.map(({ params: _params, ...event }) => event)).toEqual([
      {
        kind: 'commandsAvailable',
        method: '_kiro.dev/commands/available',
        sessionId: 's1',
      },
      {
        kind: 'mcpOauthRequest',
        method: '_kiro.dev/mcp/oauth_request',
        serverName: 'docs',
        url: 'https://auth.example/x',
      },
      {
        kind: 'mcpServerInitialized',
        method: '_kiro.dev/mcp/server_initialized',
        serverName: 'bus',
      },
      {
        kind: 'compactionStatus',
        method: '_kiro.dev/compaction/status',
        sessionId: 's1',
        status: 'started',
      },
      {
        kind: 'clearStatus',
        method: '_kiro.dev/clear/status',
        sessionId: 's1',
        status: 'completed',
      },
      {
        kind: 'metadata',
        method: '_kiro.dev/metadata',
        sessionId: 's1',
        contextUsagePercentage: 42.5,
      },
      { kind: 'agentSwitched', method: '_kiro.dev/agent/switched' },
      {
        kind: 'sessionTerminate',
        method: '_session/terminate',
        sessionId: 'sub-1',
      },
      { kind: 'metadata', method: '_kiro.dev/metadata' },
    ]);
    expect(kiroEvents[0]?.params).toEqual(KIRO_NOTIFICATIONS[0]?.[1]);
    expect(kiroEvents.at(-1)?.params).toEqual({});
  });

  it('ignores extension methods it was not asked to listen for', async () => {
    const client = await connectKiroLike();
    const methods: string[] = [];
    client.subscribe((event) => {
      if (event.type === 'extension') methods.push(event.method);
    });
    try {
      const { sessionId } = await client.newSession({
        cwd: tmpdir(),
        mcpServers: [],
      });
      await client.prompt(sessionId, 'go');
    } finally {
      await client.close();
    }
    expect(methods).not.toContain('_other.dev/ignored');
    expect(methods).toHaveLength(KIRO_EXTENSION_NOTIFICATIONS.length + 1);
  });

  it('answers Kiro extension requests with method-not-found', async () => {
    const events: AcpClientEvent[] = [];
    const client = await connectAcpClient({
      stream: kiroLikeAgent(),
      options: clientOptions({ onEvent: (event) => events.push(event) }),
    });
    try {
      const { sessionId } = await client.newSession({
        cwd: tmpdir(),
        mcpServers: [],
      });
      await client.prompt(sessionId, 'go');
    } finally {
      await client.close();
    }
    expect(agentText(events)).toBe(
      `token request: ${RequestError.methodNotFound('').code}`,
    );
  });

  it('does not map methods outside the Kiro set', () => {
    expect(toKiroEvent('_other.dev/ignored', {})).toBeUndefined();
  });
});
