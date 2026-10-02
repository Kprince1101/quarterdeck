import type {
  IntentName,
  IntentPayload,
  IntentReply,
} from '../intents/index.js';
import type { ApiContext, IntentHandlers } from './context.js';
import { BOARD_HANDLERS } from './handlers/board.js';
import { CREW_HANDLERS } from './handlers/crew.js';
import { WORKSPACE_HANDLERS } from './handlers/workspace.js';

export const INTENT_HANDLERS: IntentHandlers<IntentName> = {
  ...CREW_HANDLERS,
  ...BOARD_HANDLERS,
  ...WORKSPACE_HANDLERS,
};

export const dispatchIntent = <N extends IntentName>(
  ctx: ApiContext,
  name: N,
  input: IntentPayload<N>,
): Promise<IntentReply> => INTENT_HANDLERS[name](ctx, input, name);
