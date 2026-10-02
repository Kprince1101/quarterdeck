import type { ReadIntentName } from '../../intents/index.js';
import type { IntentHandlers } from '../context.js';
import { readTurn } from './turns.js';
import { readUsage } from './usage.js';

export const READ_HANDLERS: IntentHandlers<ReadIntentName> = {
  'turn.read': readTurn,
  'usage.read': readUsage,
};
