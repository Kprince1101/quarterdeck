import type {
  IntentName,
  IntentPayload,
  IntentReply,
} from '../intents/index.js';
import type { ApiContext, IntentHandlers } from './context.js';
import { BOARD_HANDLERS } from './handlers/board.js';
import { CREW_HANDLERS } from './handlers/crew.js';
import { DATA_HANDLERS } from './handlers/data.js';
import { KEEP_AWAKE_HANDLERS } from './handlers/keep-awake.js';
import { READ_HANDLERS } from './handlers/read.js';
import { SERVICES_HANDLERS } from './handlers/services.js';
import { SETUP_HANDLERS } from './handlers/setup.js';
import { WORKSPACE_HANDLERS } from './handlers/workspace.js';

export const INTENT_HANDLERS: IntentHandlers<IntentName> = {
  ...CREW_HANDLERS,
  ...BOARD_HANDLERS,
  ...WORKSPACE_HANDLERS,
  ...DATA_HANDLERS,
  ...READ_HANDLERS,
  ...SERVICES_HANDLERS,
  ...SETUP_HANDLERS,
  ...KEEP_AWAKE_HANDLERS,
};

export const dispatchIntent = <N extends IntentName>(
  ctx: ApiContext,
  name: N,
  input: IntentPayload<N>,
): Promise<IntentReply> => INTENT_HANDLERS[name](ctx, input, name);
