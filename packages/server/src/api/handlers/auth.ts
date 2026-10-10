import {
  ClaudeAuthError,
  claudeAuthStatus,
} from '../../acp/runtimes/claude/auth.js';
import type { AuthReadResult } from '../../intents/index.js';
import type { IntentHandler } from '../context.js';
import { conflict } from '../http-error.js';
import { unrecorded } from '../record.js';

export const readAuth: IntentHandler<'auth.read'> = async (
  ctx,
  _input,
  name,
) => {
  try {
    const read: AuthReadResult = {
      claude: await claudeAuthStatus({ homeDir: ctx.homeDir }),
    };
    return unrecorded(name, read);
  } catch (err) {
    if (err instanceof ClaudeAuthError) throw conflict(err.message);
    throw err;
  }
};
