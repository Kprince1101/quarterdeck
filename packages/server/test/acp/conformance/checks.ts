import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type {
  AuthMethod,
  RequestPermissionOutcome,
  StopReason,
} from '@agentclientprotocol/sdk';
import {
  FAKE_AUTH_METHOD_ID,
  FAKE_PERMISSION_OPTIONS,
  FAKE_PERMISSION_TOOL_CALL_ID,
  FAKE_TOOL_CALL_ID,
  LARGE_OUTPUT_MIN_BYTES,
  LARGE_OUTPUT_TOOL_CALL_ID,
  LONG_OUTPUT_CHUNKS,
  WAITING_TEXT,
} from '../fake-agent/constants.ts';
import { fakeAgentLaunch } from '../fake-agent/launch.ts';
import {
  expectedLargeOutput,
  expectedLongOutput,
} from '../fake-agent/long-output.ts';
import type { FakeAgentOptions, FakeScenario } from '../fake-agent/types.ts';
import { createRecorder, withTimeout } from './recorder.ts';
import type { Recorder } from './recorder.ts';
import type {
  ConformanceAdapter,
  ConformanceCheck,
  ConformanceConnection,
  PermissionDecider,
  SessionOpening,
} from './types.ts';
import {
  agentChunks,
  agentText,
  toolCallStatuses,
  toolCallText,
} from './updates.ts';

interface CheckContext {
  connection: ConformanceConnection;
  recorder: Recorder;
}

interface CheckSetup {
  agent?: FakeAgentOptions;
  decide?: PermissionDecider;
}

const SESSION_CWD = tmpdir();

const refuseUnexpected: PermissionDecider = (request) =>
  Promise.reject(
    new Error(`unexpected permission request ${request.toolCall.toolCallId}`),
  );

const neverDecide: PermissionDecider = () => new Promise(() => {});

const failingRules: PermissionDecider = () =>
  Promise.reject(new Error('rules lookup failed'));

const FAIL_CLOSED_STOP_REASONS: readonly StopReason[] = [
  'cancelled',
  'end_turn',
];

const selectOption =
  (optionId: string): PermissionDecider =>
  (): Promise<RequestPermissionOutcome> =>
    Promise.resolve({ outcome: 'selected', optionId });

const withAdapter = async (
  adapter: ConformanceAdapter,
  setup: CheckSetup,
  run: (context: CheckContext) => Promise<void>,
): Promise<void> => {
  const recorder = createRecorder(setup.decide ?? refuseUnexpected);
  const connection = await withTimeout(
    'connect',
    adapter.connect(fakeAgentLaunch(setup.agent), recorder.hooks),
  );
  try {
    await run({ connection, recorder });
  } finally {
    await connection.close();
  }
};

const openingFailure = (
  opening: SessionOpening,
  expected: SessionOpening['status'],
  message: string,
) =>
  new assert.AssertionError({
    message,
    actual: opening.status,
    expected,
    operator: 'strictEqual',
  });

const readySessionId = (opening: SessionOpening): string => {
  if (opening.status === 'ready') return opening.sessionId;
  throw openingFailure(opening, 'ready', 'session/new should succeed');
};

const requiredAuthMethods = (
  opening: SessionOpening,
  message: string,
): AuthMethod[] => {
  if (opening.status === 'auth_required') return opening.authMethods;
  throw openingFailure(opening, 'auth_required', message);
};

const openSession = (connection: ConformanceConnection) =>
  withTimeout('session/new', connection.openSession(SESSION_CWD));

const openReadySession = async (
  connection: ConformanceConnection,
): Promise<string> => readySessionId(await openSession(connection));

const promptTo = (
  connection: ConformanceConnection,
  sessionId: string,
  scenario: FakeScenario | string,
) => withTimeout(`prompt ${scenario}`, connection.prompt(sessionId, scenario));

const streamsAgentText: ConformanceCheck = {
  name: 'streams agent message chunks for the prompting session',
  run: (adapter) =>
    withAdapter(adapter, {}, async ({ connection, recorder }) => {
      const sessionId = await openReadySession(connection);
      const stopReason = await promptTo(connection, sessionId, 'hello deck');
      assert.equal(stopReason, 'end_turn');
      assert.equal(agentText(recorder.updates, sessionId), 'hello deck');
    }),
};

const keepsSessionsApart: ConformanceCheck = {
  name: 'attributes updates to the session that produced them',
  run: (adapter) =>
    withAdapter(adapter, {}, async ({ connection, recorder }) => {
      const first = await openReadySession(connection);
      const second = await openReadySession(connection);
      assert.notEqual(first, second);
      await promptTo(connection, first, 'first');
      await promptTo(connection, second, 'second');
      assert.equal(agentText(recorder.updates, first), 'first');
      assert.equal(agentText(recorder.updates, second), 'second');
    }),
};

const surfacesToolCalls: ConformanceCheck = {
  name: 'surfaces a tool call and its updates in order',
  run: (adapter) =>
    withAdapter(adapter, {}, async ({ connection, recorder }) => {
      const sessionId = await openReadySession(connection);
      const stopReason = await promptTo(connection, sessionId, 'tool_call');
      assert.equal(stopReason, 'end_turn');
      assert.deepEqual(
        toolCallStatuses(recorder.updates, sessionId, FAKE_TOOL_CALL_ID),
        ['pending', 'in_progress', 'completed'],
      );
      assert.equal(agentText(recorder.updates, sessionId), 'read complete');
    }),
};

const routesPermissionToRules: ConformanceCheck = {
  name: 'routes a permission request to the rules and applies an allow',
  run: (adapter) =>
    withAdapter(
      adapter,
      { decide: selectOption('allow-once') },
      async ({ connection, recorder }) => {
        const sessionId = await openReadySession(connection);
        const stopReason = await promptTo(connection, sessionId, 'permission');
        assert.equal(stopReason, 'end_turn');
        assert.equal(recorder.permissionRequests.length, 1);
        const [request] = recorder.permissionRequests;
        assert.equal(request?.sessionId, sessionId);
        assert.equal(
          request?.toolCall.toolCallId,
          FAKE_PERMISSION_TOOL_CALL_ID,
        );
        assert.deepEqual(
          request?.options.map((option) => option.optionId),
          FAKE_PERMISSION_OPTIONS.map((option) => option.optionId),
        );
        assert.deepEqual(
          toolCallStatuses(
            recorder.updates,
            sessionId,
            FAKE_PERMISSION_TOOL_CALL_ID,
          ),
          ['pending', 'completed'],
        );
        assert.equal(
          agentText(recorder.updates, sessionId),
          'permission granted: allow-once',
        );
      },
    ),
};

const honoursRejection: ConformanceCheck = {
  name: 'answers with the rules rejection instead of trusting the tool',
  run: (adapter) =>
    withAdapter(
      adapter,
      { decide: selectOption('reject-once') },
      async ({ connection, recorder }) => {
        const sessionId = await openReadySession(connection);
        const stopReason = await promptTo(connection, sessionId, 'permission');
        assert.equal(stopReason, 'end_turn');
        assert.deepEqual(
          toolCallStatuses(
            recorder.updates,
            sessionId,
            FAKE_PERMISSION_TOOL_CALL_ID,
          ),
          ['pending', 'failed'],
          'the rules rejection must reach the agent',
        );
        assert.equal(
          agentText(recorder.updates, sessionId),
          'permission rejected: reject-once',
        );
      },
    ),
};

const failsClosedOnRulesError: ConformanceCheck = {
  name: 'fails closed when the rules lookup errors',
  run: (adapter) =>
    withAdapter(
      adapter,
      { decide: failingRules },
      async ({ connection, recorder }) => {
        const sessionId = await openReadySession(connection);
        const stopReason = await promptTo(connection, sessionId, 'permission');
        const statuses = toolCallStatuses(
          recorder.updates,
          sessionId,
          FAKE_PERMISSION_TOOL_CALL_ID,
        );
        assert.ok(
          !agentText(recorder.updates, sessionId).includes(
            'permission granted',
          ),
          'a rules error must never reach the agent as an allow',
        );
        assert.ok(
          !statuses.includes('completed'),
          'a rules error must never let the tool complete',
        );
        assert.ok(
          FAIL_CLOSED_STOP_REASONS.includes(stopReason),
          `a rules error must cancel or reject, not stop with ${stopReason}`,
        );
        if (stopReason === 'end_turn') {
          assert.deepEqual(statuses, ['pending', 'failed']);
        }
      },
    ),
};

const cancelsRunningTurn: ConformanceCheck = {
  name: 'cancels a running turn and reports the cancelled stop reason',
  run: (adapter) =>
    withAdapter(adapter, {}, async ({ connection, recorder }) => {
      const sessionId = await openReadySession(connection);
      const turn = promptTo(connection, sessionId, 'wait_for_cancel');
      await recorder.waitFor('the agent to start working', () =>
        agentText(recorder.updates, sessionId).includes(WAITING_TEXT),
      );
      await connection.cancel(sessionId);
      assert.equal(await turn, 'cancelled');
    }),
};

const cancelsPendingPermission: ConformanceCheck = {
  name: 'answers a pending permission request as cancelled on cancel',
  run: (adapter) =>
    withAdapter(
      adapter,
      { decide: neverDecide },
      async ({ connection, recorder }) => {
        const sessionId = await openReadySession(connection);
        const turn = promptTo(connection, sessionId, 'permission');
        await recorder.waitFor(
          'the permission request',
          () => recorder.permissionRequests.length > 0,
        );
        await connection.cancel(sessionId);
        assert.equal(await turn, 'cancelled');
      },
    ),
};

const deliversLongOutput: ConformanceCheck = {
  name: 'delivers long streamed output intact and in order',
  run: (adapter) =>
    withAdapter(adapter, {}, async ({ connection, recorder }) => {
      const sessionId = await openReadySession(connection);
      const stopReason = await promptTo(connection, sessionId, 'long_output');
      assert.equal(stopReason, 'end_turn');
      assert.equal(
        agentChunks(recorder.updates, sessionId).length,
        LONG_OUTPUT_CHUNKS,
      );
      assert.equal(
        agentText(recorder.updates, sessionId),
        expectedLongOutput(),
      );
    }),
};

const deliversLargeMessage: ConformanceCheck = {
  name: 'delivers a single message over 1 MB intact',
  run: (adapter) =>
    withAdapter(adapter, {}, async ({ connection, recorder }) => {
      const sessionId = await openReadySession(connection);
      const stopReason = await promptTo(connection, sessionId, 'large_output');
      assert.equal(stopReason, 'end_turn');
      assert.deepEqual(
        toolCallStatuses(
          recorder.updates,
          sessionId,
          LARGE_OUTPUT_TOOL_CALL_ID,
        ),
        ['pending', 'completed'],
      );
      const text = toolCallText(
        recorder.updates,
        sessionId,
        LARGE_OUTPUT_TOOL_CALL_ID,
      );
      assert.ok(
        text.length >= LARGE_OUTPUT_MIN_BYTES,
        `large tool output was cut to ${text.length} bytes`,
      );
      assert.ok(text === expectedLargeOutput(), 'large tool output changed');
    }),
};

const surfacesSignIn: ConformanceCheck = {
  name: 'surfaces auth required and never signs in on its own',
  run: (adapter) =>
    withAdapter(
      adapter,
      { agent: { requireAuth: true } },
      async ({ connection }) => {
        const authMethods = requiredAuthMethods(
          await openSession(connection),
          'session/new should surface auth required',
        );
        assert.ok(
          authMethods.some((method) => method.id === FAKE_AUTH_METHOD_ID),
          'auth required should carry the agent auth methods',
        );
        requiredAuthMethods(
          await openSession(connection),
          'the adapter must not sign in without being told to',
        );
        await connection.authenticate(FAKE_AUTH_METHOD_ID);
        await openReadySession(connection);
      },
    ),
};

export const CHECKS = {
  streamsAgentText,
  keepsSessionsApart,
  surfacesToolCalls,
  routesPermissionToRules,
  honoursRejection,
  failsClosedOnRulesError,
  cancelsRunningTurn,
  cancelsPendingPermission,
  deliversLongOutput,
  deliversLargeMessage,
  surfacesSignIn,
} satisfies Record<string, ConformanceCheck>;

export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] =
  Object.values(CHECKS);
