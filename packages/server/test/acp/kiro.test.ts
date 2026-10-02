import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  defaultKiroProcessDir,
  KIRO_ADAPTER,
  KIRO_EXTENSION_NOTIFICATIONS,
  KIRO_SHADOW_CONFIG_CARD,
  kiroAgentConfigPath,
  KiroConfigError,
  KiroShadowConfigError,
  subscribeKiroEvents,
  toKiroEvent,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  KiroEvent,
  LaunchOptions,
} from '@quarterdeck/server';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeAgentLaunch } from './fake-agent/launch.ts';
import { describeRuntimeConformance } from './runtime-conformance.ts';

const root = mkdtempSync(join(tmpdir(), 'quarterdeck-kiro-'));
const agentsDir = join(root, 'agents');
const processDir = join(root, 'process');
const worktree = join(root, 'worktree');
mkdirSync(worktree);
const adapter = createKiroAdapter({ agentsDir, processDir });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const PROJECT = 'deck';

const CWD_AGENT = fileURLToPath(
  new URL('kiro-fixtures/cwd-agent.ts', import.meta.url),
);

const clientOptions = (
  overrides: Partial<LaunchOptions> = {},
): LaunchOptions => ({
  clientName: 'quarterdeck-kiro-test',
  clientVersion: '0.0.0',
  spawnRetries: 0,
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
  kiroAgentConfigPath(agentsDir, `quarterdeck-${PROJECT}-${name}`);

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

describeRuntimeConformance(adapter, {
  project: PROJECT,
  agentName: 'conformance',
});

describe('kiro command', () => {
  it('runs kiro-cli acp --agent from the Quarterdeck kiro folder', () => {
    expect(
      KIRO_ADAPTER.command({
        cwd: '/work/deck',
        project: 'deck',
        agentName: 'narwhal',
        env: { PATH: '/bin' },
      }),
    ).toEqual({
      command: 'kiro-cli',
      args: ['acp', '--agent', 'quarterdeck-deck-narwhal'],
      cwd: defaultKiroProcessDir(),
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
      expect(() =>
        KIRO_ADAPTER.command({ cwd: '/w', project: PROJECT, agentName }),
      ).toThrow(KiroConfigError);
    },
  );

  it.each(['', '../escape', 'a/b'])('refuses project %j', (project) => {
    expect(() =>
      KIRO_ADAPTER.command({ cwd: '/w', project, agentName: 'narwhal' }),
    ).toThrow(KiroConfigError);
  });

  it('refuses a launch with no project or agent name', async () => {
    expect(() => KIRO_ADAPTER.command({ cwd: '/w', project: PROJECT })).toThrow(
      KiroConfigError,
    );
    expect(() => KIRO_ADAPTER.command({ cwd: '/w', agentName: 'x' })).toThrow(
      KiroConfigError,
    );
    await expect(
      adapter.connect(
        { cwd: worktree, agentName: 'x', command: fakeAgentLaunch() },
        clientOptions(),
      ),
    ).rejects.toBeInstanceOf(KiroConfigError);
  });
});

describe('kiro process directory', () => {
  it('launches kiro-cli in its own folder, never the worktree', async () => {
    const marker = join(root, 'cwd-marker');
    const events: AcpClientEvent[] = [];
    const fake = fakeAgentLaunch();
    const client = await adapter.connect(
      {
        cwd: worktree,
        project: PROJECT,
        agentName: 'cwd',
        env: { ...process.env, QUARTERDECK_CWD_MARKER: marker },
        command: {
          command: fake.command,
          args: fake.args.map((arg) => {
            if (arg.endsWith('main.ts')) return CWD_AGENT;
            return arg;
          }),
        },
      },
      clientOptions({ onEvent: (event) => events.push(event) }),
    );
    await client.close();
    expect(
      events.flatMap((event) => {
        if (event.type !== 'agent_version') return [];
        return [event.stage];
      }),
    ).toEqual(['before_spawn', 'after_spawn']);
    const spawnedIn = readFileSync(marker, 'utf8');
    expect(spawnedIn).toBe(realpathSync(processDir));
    expect(spawnedIn).not.toBe(realpathSync(worktree));
  });
});

describe('kiro workspace shadow', () => {
  it.each(['json', 'md'])(
    'refuses to start when the worktree has its own .%s agent',
    async (extension) => {
      const shadowDir = join(worktree, '.kiro', 'agents');
      const shadow = join(
        shadowDir,
        `quarterdeck-${PROJECT}-shadowed.${extension}`,
      );
      mkdirSync(shadowDir, { recursive: true });
      writeFileSync(shadow, '{"allowedTools":["*"]}');
      const spawned: AcpClientEvent[] = [];
      try {
        const error: unknown = await adapter
          .connect(
            {
              cwd: worktree,
              project: PROJECT,
              agentName: 'shadowed',
              command: fakeAgentLaunch(),
            },
            clientOptions({ onEvent: (event) => spawned.push(event) }),
          )
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        expect(error).toBeInstanceOf(KiroShadowConfigError);
        expect(error).toMatchObject({
          cardKind: KIRO_SHADOW_CONFIG_CARD,
          agentName: `quarterdeck-${PROJECT}-shadowed`,
          path: shadow,
        });
        expect(spawned).toEqual([]);
        expect(existsSync(configPath('shadowed'))).toBe(false);
      } finally {
        rmSync(join(worktree, '.kiro'), { recursive: true, force: true });
      }
    },
  );
});

describe('kiro agent config', () => {
  it('writes the bus MCP into the agent config and removes it on close', async () => {
    const events: AcpClientEvent[] = [];
    const client = await adapter.connect(
      {
        cwd: worktree,
        project: PROJECT,
        agentName: 'narwhal',
        mcpServers: [BUS, DOCS, EVENTS],
        command: fakeAgentLaunch(),
      },
      clientOptions({ onEvent: (event) => events.push(event) }),
    );
    const path = configPath('narwhal');
    try {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        name: 'quarterdeck-deck-narwhal',
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
        cwd: worktree,
        mcpServers: [BUS, DOCS, EVENTS, SEARCH],
      });
      await client.prompt(sessionId, 'describe_session');
      expect(JSON.parse(agentText(events))).toEqual({
        cwd: worktree,
        mcpServers: ['events', 'search'],
      });
    } finally {
      await client.close();
    }
    expect(existsSync(path)).toBe(false);
  });

  it('keeps two projects with the same agent name apart', async () => {
    const first = await adapter.connect(
      {
        cwd: worktree,
        project: 'alpha',
        agentName: 'twin',
        command: fakeAgentLaunch(),
      },
      clientOptions(),
    );
    const second = await adapter.connect(
      {
        cwd: worktree,
        project: 'beta',
        agentName: 'twin',
        command: fakeAgentLaunch(),
      },
      clientOptions(),
    );
    const betaPath = kiroAgentConfigPath(agentsDir, 'quarterdeck-beta-twin');
    try {
      await first.close();
      expect(existsSync(betaPath)).toBe(true);
    } finally {
      await second.close();
    }
    expect(existsSync(betaPath)).toBe(false);
  });

  it('removes the config when the agent fails to start', async () => {
    await expect(
      adapter.connect(
        {
          cwd: worktree,
          project: PROJECT,
          agentName: 'nostart',
          command: { command: join(root, 'missing-kiro-cli'), args: [] },
        },
        clientOptions(),
      ),
    ).rejects.toBeInstanceOf(AcpClientError);
    expect(existsSync(configPath('nostart'))).toBe(false);
  });

  it('removes the config when the agent exits on its own', async () => {
    const client = await adapter.connect(
      {
        cwd: worktree,
        project: PROJECT,
        agentName: 'crasher',
        command: fakeAgentLaunch(),
      },
      clientOptions(),
    );
    const { sessionId } = await client.newSession({
      cwd: worktree,
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
