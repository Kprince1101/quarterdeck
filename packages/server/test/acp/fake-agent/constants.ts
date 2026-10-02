import type { PermissionOption, SessionMode } from '@agentclientprotocol/sdk';
import type { FakeScenario } from './types.ts';

export const FAKE_AGENT_NAME = 'quarterdeck-fake-agent';
export const FAKE_AGENT_VERSION = '0.0.0';
export const FAKE_AUTH_METHOD_ID = 'fake-login';
export const FAKE_TOOL_CALL_ID = 'fake-read-1';
export const FAKE_PERMISSION_TOOL_CALL_ID = 'fake-edit-1';
export const FAKE_PERMISSION_PATH = '/fake/project/config.json';
export const FAKE_READ_PATH = '/fake/project/README.md';
export const FAKE_READ_CONTENT = '# Fake project\n';
export const LONG_OUTPUT_CHUNKS = 400;
export const LONG_OUTPUT_LINE_WIDTH = 120;
export const LARGE_OUTPUT_TOOL_CALL_ID = 'fake-large-read-1';
export const LARGE_OUTPUT_PATH = '/fake/project/large.txt';
export const LARGE_OUTPUT_LINES = 8400;
export const LARGE_OUTPUT_MIN_BYTES = 1024 * 1024;
export const WAITING_TEXT = 'waiting for cancel';
export const FAKE_HISTORY_TEXT = 'earlier prompt';
export const FAKE_READY_LINE = 'quarterdeck fake agent ready';
export const FAKE_CRASH_EXIT_CODE = 3;

export const FAKE_SCENARIOS: readonly FakeScenario[] = [
  'echo',
  'tool_call',
  'permission',
  'long_output',
  'large_output',
  'wait_for_cancel',
  'describe_session',
  'describe_mode',
  'crash',
  'sign_in_lapsed',
];

export const SIGNED_IN_AGAIN_TEXT = 'signed in again';

export const FAKE_DEFAULT_MODE_ID = 'default';
export const FAKE_INITIAL_MODE_ID = 'accept_edits';
export const FAKE_MODES: SessionMode[] = [
  { id: FAKE_DEFAULT_MODE_ID, name: 'Default' },
  { id: FAKE_INITIAL_MODE_ID, name: 'Accept edits' },
];

export const FAKE_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];
