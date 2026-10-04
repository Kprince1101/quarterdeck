import { createIntentClient } from './intents.js';
import { createRulesReader } from './rules.js';

export {
  IntentError,
  KEEPALIVE_BODY_LIMIT,
  authHeaders,
  createIntentClient,
  createIntentSender,
  type IntentClient,
  type IntentClientOptions,
  type IntentGroup,
  type IntentReplyOf,
  type IntentSendOptions,
  type IntentSender,
  type SendIntent,
} from './intents.js';
export {
  RulesReadError,
  createRulesReader,
  type RulesReader,
} from './rules.js';
export {
  CLOSE_NORMAL,
  MAX_RETRY_DELAY_MS,
  RETRY_DELAY_MS,
  defaultStreamUrl,
  openStream,
  resumeUrl,
  type StreamConnection,
  type StreamListener,
  type StreamOptions,
} from './stream.js';
export {
  DEFAULT_STREAM_LIMITS,
  STREAM_EVENT_LIMIT,
  STREAM_TURNS_PER_AGENT,
  UNPAUSED_MACHINE,
  applyStreamMessage,
  emptyTables,
  initialStreamState,
  type StreamLimits,
  type StreamState,
  type StreamStatus,
} from './stream-state.js';
export {
  TOKEN_PARAM,
  TOKEN_STORAGE_KEY,
  takePageToken,
  type TokenPage,
} from './token.js';
export { useStream } from './use-stream.js';
export type {
  IntentInput,
  IntentName,
  IntentReply,
  RuleLayer,
  RuleView,
  RulesView,
} from '@quarterdeck/server/intents';
export type * from '@quarterdeck/server/stream-schema';

export const intents = createIntentClient();

export const readRules = createRulesReader();
