import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ClientConnection,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectFakeAgentInProcess,
  FAKE_AGENT_ENTRY,
  FAKE_AGENT_FLAGS,
  FAKE_AGENT_NAME,
  FAKE_AUTH_METHOD_ID,
  FAKE_DEFAULT_MODE_ID,
  FAKE_HISTORY_TEXT,
  FAKE_INITIAL_MODE_ID,
  FAKE_MODES,
  expectedLargeOutput,
  fakeAgentLaunch,
  LARGE_OUTPUT_MIN_BYTES,
  parseFakeAgentArgs,
  resolveScenario,
  toFakeAgentArgs,
} from './fake-agent/index.ts';
import type { FakeAgentOptions } from './fake-agent/index.ts';

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const AUTH_REQUIRED = -32000;

interface InProcessSetup {
  agent?: FakeAgentOptions;
  permission?: RequestPermissionResponse;
}

const open: ClientConnection[] = [];

const connect = (setup: InProcessSetup = {}) => {
  const updates: SessionUpdate[] = [];
  const connection = client({ name: 'fake-agent-test' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params.update);
    })
    .onRequest(
      'session/request_permission',
      () => setup.permission ?? { outcome: { outcome: 'cancelled' } },
    )
    .connect(connectFakeAgentInProcess(setup.agent));
  open.push(connection);
  return { agent: connection.agent, updates };
};

const initialize = (agent: ClientConnection['agent']) =>
  agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });

afterEach(() => {
  open.splice(0).forEach((connection) => connection.close());
});

describe('fake agent arguments', () => {
  it('round-trips options through argv', () => {
    const options = { requireAuth: true, stepDelayMs: 5 };
    expect(parseFakeAgentArgs(toFakeAgentArgs(options))).toEqual(options);
  });

  it('defaults to no auth and no delay', () => {
    expect(parseFakeAgentArgs([])).toEqual({ requireAuth: false });
    expect(toFakeAgentArgs({})).toEqual([]);
  });

  it('round-trips every process and capability flag', () => {
    const options = {
      requireAuth: false,
      supportsLoad: true,
      supportsResume: true,
      announce: true,
      silent: true,
      linger: true,
      ignoreSigterm: true,
      crew: true,
      crashDriver: true,
      builderAsks: true,
      plannerSkipsDesign: true,
      plannerSkipsDesignTwice: true,
      plannerSpreads: true,
      plannerNamesUnknown: true,
      onGitlab: true,
      leaksApiKey: true,
    };
    expect(parseFakeAgentArgs(toFakeAgentArgs(options))).toEqual(options);
    expect(toFakeAgentArgs(options)).toEqual(Object.values(FAKE_AGENT_FLAGS));
  });

  it('ignores arguments it does not know', () => {
    expect(parseFakeAgentArgs(['qd-marker-123'])).toEqual({
      requireAuth: false,
    });
  });

  it('rejects a malformed step delay', () => {
    expect(() => parseFakeAgentArgs(['--step-delay-ms=soon'])).toThrow(
      /non-negative integer/,
    );
  });

  it('launches the entry point with the current node', () => {
    const launch = fakeAgentLaunch({ requireAuth: true });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toContain(FAKE_AGENT_ENTRY);
    expect(launch.args.at(-1)).toBe('--require-auth');
  });
});

describe('fake agent scenarios', () => {
  it.each([
    ['tool_call', 'tool_call'],
    ['  permission\n', 'permission'],
    ['long_output', 'long_output'],
    ['large_output', 'large_output'],
    ['wait_for_cancel', 'wait_for_cancel'],
    ['describe_session', 'describe_session'],
    ['describe_mode', 'describe_mode'],
    ['crash', 'crash'],
    ['anything else', 'echo'],
  ])('resolves %j to %s', (text, scenario) => {
    expect(resolveScenario(text)).toBe(scenario);
  });
});

describe('fake agent large output', () => {
  it('is a single payload of at least 1 MB', () => {
    expect(Buffer.byteLength(expectedLargeOutput())).toBeGreaterThanOrEqual(
      LARGE_OUTPUT_MIN_BYTES,
    );
  });

  it('sends the payload as one tool call update', async () => {
    const { agent, updates } = connect();
    await initialize(agent);
    const { sessionId } = await agent.request('session/new', {
      cwd: '/fake',
      mcpServers: [],
    });
    await agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'large_output' }],
    });
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
    ]);
    expect(JSON.stringify(updates[1]).length).toBeGreaterThanOrEqual(
      LARGE_OUTPUT_MIN_BYTES,
    );
  });
});

describe('fake agent protocol', () => {
  it('initializes with the ACP version and a sign-in method', async () => {
    const { agent } = connect();
    const response = await initialize(agent);
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentInfo?.name).toBe(FAKE_AGENT_NAME);
    expect(response.authMethods?.map((method) => method.id)).toEqual([
      FAKE_AUTH_METHOD_ID,
    ]);
  });

  it('requires sign-in before a session when configured', async () => {
    const { agent } = connect({ agent: { requireAuth: true } });
    await initialize(agent);
    await expect(
      agent.request('session/new', { cwd: '/fake', mcpServers: [] }),
    ).rejects.toMatchObject({ code: AUTH_REQUIRED });
    await agent.request('authenticate', { methodId: FAKE_AUTH_METHOD_ID });
    await expect(
      agent.request('session/new', { cwd: '/fake', mcpServers: [] }),
    ).resolves.toMatchObject({ sessionId: 'fake-session-1' });
  });

  it('rejects an unknown auth method', async () => {
    const { agent } = connect({ agent: { requireAuth: true } });
    await initialize(agent);
    await expect(
      agent.request('authenticate', { methodId: 'nope' }),
    ).rejects.toMatchObject({ code: INVALID_PARAMS });
  });

  it('rejects a prompt for an unknown session', async () => {
    const { agent } = connect();
    await initialize(agent);
    await expect(
      agent.request('session/prompt', {
        sessionId: 'missing',
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: INVALID_PARAMS });
  });

  it('rejects a permission answer that names an option it never offered', async () => {
    const { agent } = connect({
      permission: { outcome: { outcome: 'selected', optionId: 'yolo' } },
    });
    await initialize(agent);
    const { sessionId } = await agent.request('session/new', {
      cwd: '/fake',
      mcpServers: [],
    });
    await expect(
      agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'permission' }],
      }),
    ).rejects.toMatchObject({ code: INVALID_PARAMS });
  });

  it('advertises neither load nor resume by default', async () => {
    const { agent } = connect();
    const response = await initialize(agent);
    expect(response.agentCapabilities).toEqual({ loadSession: false });
    await expect(
      agent.request('session/load', {
        sessionId: 'fake-session-9',
        cwd: '/fake',
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
  });

  it('advertises and serves load and resume when asked', async () => {
    const { agent, updates } = connect({
      agent: { supportsLoad: true, supportsResume: true },
    });
    const response = await initialize(agent);
    expect(response.agentCapabilities).toEqual({
      loadSession: true,
      sessionCapabilities: { resume: {} },
    });
    await agent.request('session/resume', {
      sessionId: 'fake-session-8',
      cwd: '/fake',
    });
    await agent.request('session/load', {
      sessionId: 'fake-session-9',
      cwd: '/fake',
      mcpServers: [],
    });
    expect(updates).toEqual([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: FAKE_HISTORY_TEXT },
      },
    ]);
    await expect(
      agent.request('session/prompt', {
        sessionId: 'fake-session-8',
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('describes the session cwd and MCP servers', async () => {
    const { agent, updates } = connect();
    await initialize(agent);
    const { sessionId } = await agent.request('session/new', {
      cwd: '/fake/project',
      mcpServers: [{ name: 'bus', command: 'node', args: [], env: [] }],
    });
    await agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'describe_session' }],
    });
    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: JSON.stringify({ cwd: '/fake/project', mcpServers: ['bus'] }),
        },
      },
    ]);
  });

  it('starts sessions outside the default mode and switches on set_mode', async () => {
    const { agent, updates } = connect();
    await initialize(agent);
    const { sessionId, modes } = await agent.request('session/new', {
      cwd: '/fake/project',
      mcpServers: [],
    });
    expect(modes).toEqual({
      currentModeId: FAKE_INITIAL_MODE_ID,
      availableModes: FAKE_MODES,
    });

    await agent.request('session/set_mode', {
      sessionId,
      modeId: FAKE_DEFAULT_MODE_ID,
    });
    await agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'describe_mode' }],
    });

    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: JSON.stringify({ modeId: FAKE_DEFAULT_MODE_ID, meta: null }),
        },
      },
    ]);
    await expect(
      agent.request('session/set_mode', { sessionId, modeId: 'yolo' }),
    ).rejects.toMatchObject({ code: INVALID_PARAMS });
  });

  it('refuses to crash when running in process', async () => {
    const { agent } = connect();
    await initialize(agent);
    const { sessionId } = await agent.request('session/new', {
      cwd: '/fake',
      mcpServers: [],
    });
    await expect(
      agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'crash' }],
      }),
    ).rejects.toMatchObject({ code: INTERNAL_ERROR });
  });

  it('honours the step delay between tool call updates', async () => {
    const { agent, updates } = connect({ agent: { stepDelayMs: 20 } });
    await initialize(agent);
    const { sessionId } = await agent.request('session/new', {
      cwd: '/fake',
      mcpServers: [],
    });
    const started = performance.now();
    await agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'tool_call' }],
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'agent_message_chunk',
    ]);
  });
});
