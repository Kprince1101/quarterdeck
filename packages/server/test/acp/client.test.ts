import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { SessionId } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClientError, spawnAcpClient } from '../../acp/client/index.js';
import type {
  AcpClient,
  AcpClientEvent,
  AgentCommand,
  PermissionHandler,
} from '../../acp/client/index.js';

type Capabilities = 'resume' | 'load' | 'none';

interface Harness {
  client: AcpClient;
  events: AcpClientEvent[];
}

const STUB_AGENT = resolve(import.meta.dirname, 'stub-agent.ts');
const PROJECT_CWD = resolve(import.meta.dirname, '..', '..');
const BUS_SERVER = {
  name: 'bus',
  command: 'node',
  args: ['bus.js'],
  env: [],
};

const stubCommand = (capabilities: Capabilities): AgentCommand => ({
  command: process.execPath,
  args: [
    '--experimental-strip-types',
    '--no-warnings',
    STUB_AGENT,
    capabilities,
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

const openClients: AcpClient[] = [];

const start = async (
  capabilities: Capabilities = 'resume',
  onPermissionRequest: PermissionHandler = rejectAll,
): Promise<Harness> => {
  const events: AcpClientEvent[] = [];
  const client = await spawnAcpClient(stubCommand(capabilities), {
    clientName: 'quarterdeck-test',
    clientVersion: '0.0.0',
    onPermissionRequest,
    onEvent: (event) => events.push(event),
  });
  openClients.push(client);
  return { client, events };
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

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe('ACP client over stdio', () => {
  it('initializes and reports the agent', async () => {
    const { client, events } = await start();

    expect(client.agent.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.agent.agentInfo?.name).toBe('stub-agent');
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
    expect(eventTypes(events).filter((type) => type !== 'stderr')).toEqual([
      'session_update',
      'session_update',
      'turn_end',
    ]);
    expect(events.at(-1)).toEqual({
      type: 'turn_end',
      sessionId,
      stopReason: 'end_turn',
    });
  });

  it('answers permission requests through the handler', async () => {
    const { client, events } = await start('resume', selectOption('allow'));
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
    const { client, events } = await start('resume', failing);
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
    const { client, events } = await start('resume', unanswered);
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
    const { client } = await start('resume');

    const resumed = await client.resumeSession({
      sessionId: 'stub-session-9',
      cwd: PROJECT_CWD,
      mcpServers: [BUS_SERVER],
    });

    expect(resumed.method).toBe('session/resume');
    expect(resumed.sessionId).toBe('stub-session-9');
  });

  it('falls back to session/load and replays history', async () => {
    const { client, events } = await start('load');

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
    const { client } = await start('none');

    await expect(
      client.resumeSession({
        sessionId: 'stub-session-9',
        cwd: PROJECT_CWD,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: 'resume_unsupported' });
  });

  it('reports a command that cannot start', async () => {
    const failure = spawnAcpClient(
      { command: resolve(PROJECT_CWD, 'missing-agent'), args: [] },
      {
        clientName: 'quarterdeck-test',
        clientVersion: '0.0.0',
        onPermissionRequest: rejectAll,
      },
    );

    await expect(failure).rejects.toBeInstanceOf(AcpClientError);
    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
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
  });

  it('stops the agent process on close', async () => {
    const { client, events } = await start();

    await client.close();

    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(['closed', 'exit']),
    );
  });
});
