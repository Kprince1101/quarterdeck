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
  FAKE_AGENT_NAME,
  FAKE_AUTH_METHOD_ID,
  expectedLargeOutput,
  fakeAgentLaunch,
  LARGE_OUTPUT_MIN_BYTES,
  parseFakeAgentArgs,
  resolveScenario,
  toFakeAgentArgs,
} from './fake-agent/index.ts';
import type { FakeAgentOptions } from './fake-agent/index.ts';

const INVALID_PARAMS = -32602;
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
