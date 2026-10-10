import type { ReadIntentName } from '../../intents/index.js';
import type { IntentHandlers } from '../context.js';
import { readAuth } from './auth.js';
import { readForge, readOpenRequests } from './forge.js';
import { readTurn } from './turns.js';
import { readUsage } from './usage.js';

export const READ_HANDLERS: IntentHandlers<ReadIntentName> = {
  'turn.read': readTurn,
  'usage.read': readUsage,
  'forge.read': readForge,
  'forge.requests': readOpenRequests,
  'auth.read': readAuth,
};
