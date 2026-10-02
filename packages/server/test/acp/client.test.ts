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

type Capabilities = 'resume' | 'load' | 'none';
type Behavior = 'serve' | 'silent' | 'linger' | 'ignore-sigterm';

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
  capabilities?: Capabilities;
  behavior?: Behavior;
  overrides?: Partial<AcpClientOptions>;
}

const STUB_AGENT = resolve(import.meta.dirname, 'stub-agent.ts');
const PROJECT_CWD = resolve(import.meta.dirname, '..', '..');
const BUS_SERVER = {
  name: 'bus',
  command: 'node',
  args: ['bus.js'],
  env: [],
};
const LIFECYCLE_TYPES = new Set<AcpClientEvent['type']>(['spawned', 'stderr']);

const stubCommand = (
  capabilities: Capabilities,
  behavior: Behavior,
): AgentCommand => ({
  command: process.execPath,
  args: [
    '--experimental-strip-types',
    '--no-warnings',
    STUB_AGENT,
    capabilities,
    behavior,
  ],
});

const rejectAll: PermissionHandler = async ({ options }) => {
  const reject = options.find((option) => option.kind === 'reject_once');
  return {
    outcome: { outcome: 'selected', optionId: reject?.optionId ?? 'reject' },
  };
};

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
    onPermissionRequest: rejectAll,
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
  capabilities = 'resume',
  behavior = 'serve',
  overrides = {},
}: StartOptions = {}): Promise<Harness> => {
  const run = createRun(overrides);
  const client = await spawnAcpClient(
    stubCommand(capabilities, behavior),
    run.options,
  );
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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const expectChildExited = async (events: AcpClientEvent[]) => {
  const pids = spawnedPids(events);
  await vi.waitFor(() => {
    pids.forEach((pid) => expect(isAlive(pid)).toBe(false));
    if (pids.length > 0) expect(eventTypes(events)).toContain('exit');
  });
};

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  const finished = runs.splice(0);
  await Promise.all(finished.map((run) => expectChildExited(run.events)));
});

describe('ACP client over stdio', () => {
  it('initializes and reports the agent', async () => {
    const { client, events } = await start();

    expect(client.agent.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.agent.agentInfo?.name).toBe('stub-agent');
    expect(spawnedPids(events)).toHaveLength(1);
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'stderr',
        line: 'stub agent ready',
      }),
    );
  });

  it('creates a session with cwd and MCP servers', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    await client.prompt(sessionId, 'describe');

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
    expect(agentText(events, sessionId)).toBe('echo:hello');
    expect(
      eventTypes(events).filter((type) => !LIFECYCLE_TYPES.has(type)),
    ).toEqual(['session_update', 'session_update', 'turn_end']);
    expect(events.at(-1)).toEqual({
      type: 'turn_end',
      sessionId,
      stopReason: 'end_turn',
    });
  });

  it('answers permission requests through the handler', async () => {
    const { client, events } = await start({
      overrides: { onPermissionRequest: selectOption('allow') },
    });
    const sessionId = await openSession(client);

    await client.prompt(sessionId, 'ask');

    expect(agentText(events, sessionId)).toBe('selected:allow');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission',
        sessionId,
        response: { outcome: { outcome: 'selected', optionId: 'allow' } },
      }),
    );
  });

  it('answers cancelled when the permission handler fails', async () => {
    const failing: PermissionHandler = async () => {
      throw new Error('card store offline');
    };
    const { client, events } = await start({
      overrides: { onPermissionRequest: failing },
    });
    const sessionId = await openSession(client);

    const response = await client.prompt(sessionId, 'ask');

    expect(response.stopReason).toBe('cancelled');
    expect(agentText(events, sessionId)).toBe('cancelled');
  });

  it('cancels a running turn', async () => {
    const { client, events } = await start();
    const sessionId = await openSession(client);

    const turn = client.prompt(sessionId, 'hang');
    await vi.waitFor(() =>
      expect(agentText(events, sessionId)).toBe('waiting'),
    );
    await client.cancel(sessionId);

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('settles a pending permission request as cancelled on cancel', async () => {
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

    const turn = client.prompt(sessionId, 'ask');
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
    const { client } = await start({ capabilities: 'resume' });

    const resumed = await client.resumeSession({
      sessionId: 'stub-session-9',
      cwd: PROJECT_CWD,
      mcpServers: [BUS_SERVER],
    });

    expect(resumed.method).toBe('session/resume');
    expect(resumed.sessionId).toBe('stub-session-9');
  });

  it('falls back to session/load and replays history', async () => {
    const { client, events } = await start({ capabilities: 'load' });

    const resumed = await client.resumeSession({
      sessionId: 'stub-session-9',
      cwd: PROJECT_CWD,
      mcpServers: [],
    });

    expect(resumed.method).toBe('session/load');
    expect(events).toContainEqual({
      type: 'session_update',
      sessionId: 'stub-session-9',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'earlier prompt' },
      },
    });
  });

  it('refuses to resume when the agent cannot', async () => {
    const { client } = await start({ capabilities: 'none' });

    await expect(
      client.resumeSession({
        sessionId: 'stub-session-9',
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
      expect(events).toContainEqual({ type: 'exit', code: 3, signal: null }),
    );
    expect(eventTypes(events)).toContain('closed');
    await expectChildExited(events);
  });

  it('stops the agent process on close', async () => {
    const { client, events } = await start({ behavior: 'linger' });

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

    const failure = spawnAcpClient(stubCommand('resume', 'silent'), options);

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

    const failure = spawnAcpClient(stubCommand('resume', 'silent'), options);
    setTimeout(() => controller.abort(), 100);

    await expect(failure).rejects.toMatchObject({
      code: 'initialize_timeout',
      message: 'ACP initialize was aborted',
    });
    await expectChildExited(events);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { events, options } = createRun({ signal: AbortSignal.abort() });

    const failure = spawnAcpClient(stubCommand('resume', 'serve'), options);

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
      behavior: 'ignore-sigterm',
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
});

describe('listener isolation', () => {
  it('close() still disposes the agent when a closed listener throws', async () => {
    const { client, events, listenerFailures } = await start({
      behavior: 'linger',
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
      overrides: { onPermissionRequest: selectOption('allow') },
    });
    client.subscribe(failingListener('permission'));
    const sessionId = await openSession(client);

    await expect(client.prompt(sessionId, 'ask')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(agentText(events, sessionId)).toBe('selected:allow');
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

    expect(agentText(later, sessionId)).toBe('echo:hello');
    await client.close();
    await expectChildExited(events);
  });
});
