import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { SessionId } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpClientError,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  spawnAcpClient,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  AcpClientOptions,
  AgentCommand,
  PermissionHandler,
} from '@quarterdeck/server';
import {
  FAKE_AGENT_NAME,
  FAKE_CRASH_EXIT_CODE,
  FAKE_DEFAULT_MODE_ID,
  FAKE_HISTORY_TEXT,
  FAKE_INITIAL_MODE_ID,
  FAKE_READY_LINE,
  fakeAgentLaunch,
} from './fake-agent/index.ts';
import type { FakeAgentOptions } from './fake-agent/index.ts';
import { expectAllExited, markedProcesses } from './process-check.ts';

interface ListenerFailure {
  message: string;
  eventType: AcpClientEvent['type'];
}

interface Run {
  events: AcpClientEvent[];
  listenerFailures: ListenerFailure[];
  options: AcpClientOptions;
}

interface Harness extends Run {
  client: AcpClient;
}

interface StartOptions {
  agent?: FakeAgentOptions;
  overrides?: Partial<AcpClientOptions>;
}

const PROJECT_CWD = resolve(import.meta.dirname, '..', '..');
const BUS_SERVER = {
  name: 'bus',
  command: 'node',
  args: ['bus.js'],
  env: [],
};
const LIFECYCLE_TYPES = new Set<AcpClientEvent['type']>([
  'spawned',
  'stderr',
  'stderr_closed',
]);
const IS_WINDOWS = process.platform === 'win32';
const RESUMED_SESSION = 'fake-session-9';

const commandLine = ({ command, args }: AgentCommand) => [command, ...args];

const shellQuote = (part: string) => `'${part.replaceAll("'", "'\\''")}'`;

const rejectOnce: PermissionHandler = async () => ({
  outcome: { outcome: 'selected', optionId: 'reject-once' },
});

const selectOption =
  (optionId: string): PermissionHandler =>
  async () => ({ outcome: { outcome: 'selected', optionId } });

const failingListener = (type: AcpClientEvent['type']) => {
  return (event: AcpClientEvent) => {
    if (event.type === type) throw new Error(`listener failed on ${type}`);
  };
};

const runs: Run[] = [];
const openClients: AcpClient[] = [];

const createRun = (overrides: Partial<AcpClientOptions> = {}): Run => {
  const events: AcpClientEvent[] = [];
  const listenerFailures: ListenerFailure[] = [];
  const options: AcpClientOptions = {
    clientName: 'quarterdeck-test',
    clientVersion: '0.0.0',
    onPermissionRequest: rejectOnce,
    onEvent: (event) => events.push(event),
    onListenerError: (err, event) => {
      listenerFailures.push({
        message: String(err),
        eventType: event.type,
      });
    },
    ...overrides,
  };
  const run = { events, listenerFailures, options };
  runs.push(run);
  return run;
};

const start = async ({
  agent = {},
  overrides = {},
}: StartOptions = {}): Promise<Harness> => {
  const run = createRun(overrides);
  const client = await spawnAcpClient(fakeAgentLaunch(agent), run.options);
  openClients.push(client);
  return { ...run, client };
};

const openSession = async (client: AcpClient) => {
  const { sessionId } = await client.newSession({
    cwd: PROJECT_CWD,
    mcpServers: [BUS_SERVER],
  });
  return sessionId;
};

const agentText = (events: AcpClientEvent[], sessionId: SessionId) =>
  events
    .flatMap((event) => {
      if (event.type !== 'session_update') return [];
      if (event.sessionId !== sessionId) return [];
      if (event.update.sessionUpdate !== 'agent_message_chunk') return [];
      if (event.update.content.type !== 'text') return [];
      return [event.update.content.text];
    })
    .join('');

const eventTypes = (events: AcpClientEvent[]) =>
  events.map((event) => event.type);

const spawnedPids = (events: AcpClientEvent[]) =>
  events.flatMap((event) => {
    if (event.type !== 'spawned') return [];
    return [event.pid];
  });

const expectChildExited = async (events: AcpClientEvent[]) => {
  await expectAllExited(spawnedPids(events));
  if (spawnedPids(events).length > 0) {
    await vi.waitFor(() => expect(eventTypes(events)).toContain('exit'));
  }
};

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  const finished = runs.splice(0);
  await Promise.all(finished.map((run) => expectChildExited(run.events)));
});

describe('ACP client over stdio', () => {
  it('initializes, reports the agent and forwards stderr', async () => {
    const { client, events } = await start({ agent: { announce: true } });

    expect(client.agent.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.agent.agentInfo?.name).toBe(FAKE_AGENT_NAME);
    expect(spawnedPids(events)).toHaveLength(1);
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'stderr', line: FAKE_READY_LINE }),
    );
  });

  it('creates a session with cwd and MCP servers', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    await client.prompt(sessionId, 'describe_session');

    expect(JSON.parse(agentText(events, sessionId))).toEqual({
      cwd: PROJECT_CWD,
      mcpServers: ['bus'],
    });
  });

  it('streams session updates before the turn ends', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    const response = await client.prompt(sessionId, [
      { type: 'text', text: 'hello' },
    ]);

    expect(response.stopReason).toBe('end_turn');
    expect(agentText(events, sessionId)).toBe('hello');
    expect(
      eventTypes(events).filter((type) => !LIFECYCLE_TYPES.has(type)),
    ).toEqual(['session_update', 'turn_end']);
    expect(events.at(-1)).toEqual({
      type: 'turn_end',
      sessionId,
      stopReason: 'end_turn',
    });
  });

  it('emits the permission request with the answer it got', async () => {
    const { client, events } = await start({
      overrides: { onPermissionRequest: selectOption('allow-once') },
    });
    const sessionId = await openSession(client);

    await client.prompt(sessionId, 'permission');

    expect(agentText(events, sessionId)).toBe('permission granted: allow-once');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission',
        sessionId,
        response: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      }),
    );
  });

  it('emits the cancelled answer for a permission settled by cancel', async () => {
    let markAsked = () => {};
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    const unanswered: PermissionHandler = () => {
      markAsked();
      return new Promise(() => {});
    };
    const { client, events } = await start({
      overrides: { onPermissionRequest: unanswered },
    });
    const sessionId = await openSession(client);

    const turn = client.prompt(sessionId, 'permission');
    await asked;
    await client.cancel(sessionId);

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission',
        response: { outcome: { outcome: 'cancelled' } },
      }),
    );
  });

  it('resumes with session/resume when the agent advertises it', async () => {
    const { client, events } = await start({
      agent: { supportsResume: true, supportsLoad: true },
    });

    const resumed = await client.resumeSession({
      sessionId: RESUMED_SESSION,
      cwd: PROJECT_CWD,
      mcpServers: [BUS_SERVER],
    });
    await client.prompt(RESUMED_SESSION, 'describe_session');

    expect(resumed.method).toBe('session/resume');
    expect(resumed.sessionId).toBe(RESUMED_SESSION);
    expect(JSON.parse(agentText(events, RESUMED_SESSION))).toEqual({
      cwd: PROJECT_CWD,
      mcpServers: ['bus'],
    });
  });

  it('falls back to session/load and replays history', async () => {
    const { client, events } = await start({ agent: { supportsLoad: true } });

    const resumed = await client.resumeSession({
      sessionId: RESUMED_SESSION,
      cwd: PROJECT_CWD,
      mcpServers: [],
    });

    expect(resumed.method).toBe('session/load');
    expect(events).toContainEqual({
      type: 'session_update',
      sessionId: RESUMED_SESSION,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: FAKE_HISTORY_TEXT },
      },
    });
  });

  it('sends session meta with session/new, session/resume and session/load', async () => {
    const meta = { claudeCode: { options: { settingSources: [] } } };
    const { client, events } = await start({
      agent: { supportsResume: true },
    });
    const { sessionId } = await client.newSession({
      cwd: PROJECT_CWD,
      mcpServers: [],
      meta,
    });
    await client.resumeSession({
      sessionId: RESUMED_SESSION,
      cwd: PROJECT_CWD,
      mcpServers: [],
      meta,
    });
    const loading = await start({ agent: { supportsLoad: true } });
    await loading.client.resumeSession({
      sessionId: RESUMED_SESSION,
      cwd: PROJECT_CWD,
      mcpServers: [],
      meta,
    });

    await client.prompt(sessionId, 'describe_mode');
    await client.prompt(RESUMED_SESSION, 'describe_mode');
    await loading.client.prompt(RESUMED_SESSION, 'describe_mode');

    [
      agentText(events, sessionId),
      agentText(events, RESUMED_SESSION),
      agentText(loading.events, RESUMED_SESSION),
    ].forEach((text) => {
      expect(JSON.parse(text)).toEqual({ modeId: FAKE_INITIAL_MODE_ID, meta });
    });
  });

  it('leaves session meta out when there is none', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    await client.prompt(sessionId, 'describe_mode');

    expect(JSON.parse(agentText(events, sessionId))).toMatchObject({
      meta: null,
    });
  });

  it('sets the session mode', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    await client.setSessionMode(sessionId, FAKE_DEFAULT_MODE_ID);
    await client.prompt(sessionId, 'describe_mode');

    expect(JSON.parse(agentText(events, sessionId))).toMatchObject({
      modeId: FAKE_DEFAULT_MODE_ID,
    });
  });

  it('rejects a mode the agent does not offer', async () => {
    const { client } = await start();
    const sessionId = await openSession(client);

    await expect(
      client.setSessionMode(sessionId, 'yolo'),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('refuses to resume when the agent cannot', async () => {
    const { client } = await start();

    await expect(
      client.resumeSession({
        sessionId: RESUMED_SESSION,
        cwd: PROJECT_CWD,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: 'resume_unsupported' });
  });

  it('reports a command that cannot start', async () => {
    const { events, options } = createRun();

    const failure = spawnAcpClient(
      { command: resolve(PROJECT_CWD, 'missing-agent'), args: [] },
      options,
    );

    await expect(failure).rejects.toBeInstanceOf(AcpClientError);
    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(spawnedPids(events)).toEqual([]);
  });

  it('rejects the turn and emits exit when the agent dies', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    await expect(client.prompt(sessionId, 'crash')).rejects.toThrow();
    await client.closed;

    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'exit',
        code: FAKE_CRASH_EXIT_CODE,
        signal: null,
      }),
    );
    expect(eventTypes(events)).toContain('closed');
    await expectChildExited(events);
  });

  it('stops the agent process on close', async () => {
    const { client, events } = await start({ agent: { linger: true } });

    await client.close();

    expect(events).toContainEqual({
      type: 'exit',
      code: null,
      signal: 'SIGTERM',
    });
    expect(eventTypes(events)).toContain('closed');
    await expectChildExited(events);
  });
});

describe('initialize deadline', () => {
  it('defaults to a bounded wait', () => {
    expect(DEFAULT_INITIALIZE_TIMEOUT_MS).toBe(30_000);
  });

  it('times out a silent agent and stops it', async () => {
    const { events, options } = createRun({ initializeTimeoutMs: 200 });

    const failure = spawnAcpClient(fakeAgentLaunch({ silent: true }), options);

    await expect(failure).rejects.toMatchObject({
      name: 'AcpClientError',
      code: 'initialize_timeout',
    });
    expect(spawnedPids(events)).toHaveLength(1);
    await expectChildExited(events);
  });

  it('aborts initialize when the signal fires and stops the agent', async () => {
    const controller = new AbortController();
    const { events, options } = createRun({
      initializeTimeoutMs: 60_000,
      signal: controller.signal,
    });

    const failure = spawnAcpClient(fakeAgentLaunch({ silent: true }), options);
    setTimeout(() => controller.abort(), 100);

    await expect(failure).rejects.toMatchObject({
      code: 'initialize_timeout',
      message: 'ACP initialize was aborted',
    });
    await expectChildExited(events);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { events, options } = createRun({ signal: AbortSignal.abort() });

    const failure = spawnAcpClient(fakeAgentLaunch(), options);

    await expect(failure).rejects.toMatchObject({
      code: 'initialize_timeout',
    });
    await expectChildExited(events);
  });
});

describe('shutdown escalation', () => {
  it('defaults the grace period to five seconds', () => {
    expect(DEFAULT_KILL_GRACE_MS).toBe(5_000);
  });

  it('sends SIGKILL when the agent ignores SIGTERM', async () => {
    const { client, events } = await start({
      agent: { ignoreSigterm: true },
      overrides: { killGraceMs: 200 },
    });

    await expect(client.close()).resolves.toBeUndefined();

    expect(events).toContainEqual({
      type: 'exit',
      code: null,
      signal: 'SIGKILL',
    });
    await expectChildExited(events);
  });

  it.skipIf(IS_WINDOWS)(
    'kills a SIGTERM-ignoring grandchild behind a shell wrapper',
    async () => {
      const marker = `qd-acp-grandchild-${process.pid}-${Date.now()}`;
      const agentLine = [
        ...commandLine(fakeAgentLaunch({ ignoreSigterm: true })),
        marker,
      ]
        .map(shellQuote)
        .join(' ');
      const { options, events } = createRun({ killGraceMs: 200 });
      const client = await spawnAcpClient(
        { command: '/bin/sh', args: ['-c', `${agentLine}; echo wrapper-done`] },
        options,
      );
      openClients.push(client);

      expect(markedProcesses(marker).length).toBeGreaterThanOrEqual(2);
      await client.close();

      expect(markedProcesses(marker)).toEqual([]);
      await expectChildExited(events);
    },
  );
});

describe('listener isolation', () => {
  it('close() still disposes the agent when a closed listener throws', async () => {
    const { client, events, listenerFailures } = await start({
      agent: { linger: true },
    });
    client.subscribe(failingListener('closed'));

    await expect(client.close()).resolves.toBeUndefined();

    expect(events).toContainEqual({
      type: 'exit',
      code: null,
      signal: 'SIGTERM',
    });
    expect(listenerFailures).toEqual([
      { message: 'Error: listener failed on closed', eventType: 'closed' },
    ]);
    await expectChildExited(events);
  });

  it('prompt() resolves when a turn_end listener throws', async () => {
    const { client, events, listenerFailures } = await start();
    client.subscribe(failingListener('turn_end'));
    const sessionId = await openSession(client);

    await expect(client.prompt(sessionId, 'hello')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(listenerFailures).toEqual([
      { message: 'Error: listener failed on turn_end', eventType: 'turn_end' },
    ]);
    await client.close();
    await expectChildExited(events);
  });

  it('keeps the permission answer when a permission listener throws', async () => {
    const { client, events, listenerFailures } = await start({
      overrides: { onPermissionRequest: selectOption('allow-once') },
    });
    client.subscribe(failingListener('permission'));
    const sessionId = await openSession(client);

    await expect(client.prompt(sessionId, 'permission')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(agentText(events, sessionId)).toBe('permission granted: allow-once');
    expect(listenerFailures).toHaveLength(1);
    await client.close();
    await expectChildExited(events);
  });

  it('keeps delivering to other listeners after one throws', async () => {
    const { client, events } = await start();
    const later: AcpClientEvent[] = [];
    client.subscribe(failingListener('session_update'));
    client.subscribe((event) => later.push(event));
    const sessionId = await openSession(client);

    await client.prompt(sessionId, 'hello');

    expect(agentText(later, sessionId)).toBe('hello');
    await client.close();
    await expectChildExited(events);
  });
});
