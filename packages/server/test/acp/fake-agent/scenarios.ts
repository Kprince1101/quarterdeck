import { RequestError } from '@agentclientprotocol/sdk';
import type {
  PermissionOptionKind,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import {
  FAKE_PERMISSION_OPTIONS,
  FAKE_PERMISSION_PATH,
  FAKE_PERMISSION_TOOL_CALL_ID,
  FAKE_READ_CONTENT,
  FAKE_READ_PATH,
  FAKE_SCENARIOS,
  FAKE_TOOL_CALL_ID,
  WAITING_TEXT,
} from './constants.ts';
import { longOutputLines } from './long-output.ts';
import { delay, waitForAbort } from './timing.ts';
import type { FakeScenario, FakeScenarioHandler, FakeTurn } from './types.ts';

interface PermissionResult {
  status: ToolCallStatus;
  verdict: string;
}

const PERMISSION_RESULTS: Record<PermissionOptionKind, PermissionResult> = {
  allow_once: { status: 'completed', verdict: 'granted' },
  allow_always: { status: 'completed', verdict: 'granted' },
  reject_once: { status: 'failed', verdict: 'rejected' },
  reject_always: { status: 'failed', verdict: 'rejected' },
};

const PERMISSION_INPUT = {
  path: FAKE_PERMISSION_PATH,
  content: '{"fake":true}',
};

const send = (turn: FakeTurn, update: SessionUpdate): Promise<void> =>
  turn.client.notify('session/update', {
    sessionId: turn.sessionId,
    update,
  });

const sendText = (turn: FakeTurn, text: string): Promise<void> =>
  send(turn, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });

const step = (turn: FakeTurn): Promise<void> =>
  delay(turn.stepDelayMs, turn.signal);

const echo: FakeScenarioHandler = async (turn) => {
  await sendText(turn, turn.text);
  return 'end_turn';
};

const toolCall: FakeScenarioHandler = async (turn) => {
  await send(turn, {
    sessionUpdate: 'tool_call',
    toolCallId: FAKE_TOOL_CALL_ID,
    title: 'Read README.md',
    kind: 'read',
    status: 'pending',
    locations: [{ path: FAKE_READ_PATH }],
    rawInput: { path: FAKE_READ_PATH },
  });
  await step(turn);
  await send(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId: FAKE_TOOL_CALL_ID,
    status: 'in_progress',
  });
  await step(turn);
  await send(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId: FAKE_TOOL_CALL_ID,
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'text', text: FAKE_READ_CONTENT } },
    ],
    rawOutput: { content: FAKE_READ_CONTENT },
  });
  await sendText(turn, 'read complete');
  return 'end_turn';
};

const permissionResult = (optionId: string): PermissionResult => {
  const option = FAKE_PERMISSION_OPTIONS.find(
    (candidate) => candidate.optionId === optionId,
  );
  if (!option) {
    throw RequestError.invalidParams(
      { optionId },
      'permission outcome names an option that was not offered',
    );
  }
  return PERMISSION_RESULTS[option.kind];
};

const permission: FakeScenarioHandler = async (turn) => {
  const toolCall: ToolCall = {
    toolCallId: FAKE_PERMISSION_TOOL_CALL_ID,
    title: 'Edit config.json',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: FAKE_PERMISSION_PATH }],
    rawInput: PERMISSION_INPUT,
  };
  await send(turn, { sessionUpdate: 'tool_call', ...toolCall });
  const response = await turn.client.request('session/request_permission', {
    sessionId: turn.sessionId,
    toolCall,
    options: FAKE_PERMISSION_OPTIONS,
  });
  if (response.outcome.outcome === 'cancelled') return 'cancelled';
  const result = permissionResult(response.outcome.optionId);
  await send(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId: FAKE_PERMISSION_TOOL_CALL_ID,
    status: result.status,
  });
  await sendText(
    turn,
    `permission ${result.verdict}: ${response.outcome.optionId}`,
  );
  return 'end_turn';
};

const longOutput: FakeScenarioHandler = async (turn) => {
  for (const line of longOutputLines()) {
    if (turn.signal.aborted) return 'cancelled';
    await sendText(turn, line);
  }
  return 'end_turn';
};

const waitForCancel: FakeScenarioHandler = async (turn) => {
  await sendText(turn, WAITING_TEXT);
  await waitForAbort(turn.signal);
  return 'cancelled';
};

const SCENARIO_HANDLERS: Record<FakeScenario, FakeScenarioHandler> = {
  echo,
  tool_call: toolCall,
  permission,
  long_output: longOutput,
  wait_for_cancel: waitForCancel,
};

export const resolveScenario = (text: string): FakeScenario =>
  FAKE_SCENARIOS.find((scenario) => scenario === text.trim()) ?? 'echo';

export const runScenario = async (turn: FakeTurn): Promise<StopReason> => {
  const stopReason = await SCENARIO_HANDLERS[resolveScenario(turn.text)](turn);
  if (turn.signal.aborted) return 'cancelled';
  return stopReason;
};
