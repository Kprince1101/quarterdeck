import type { z } from 'zod';
import { BOARD_INTENTS } from './board.js';
import { CREW_INTENTS } from './crew.js';
import { DATA_INTENTS } from './data.js';
import { KEEP_AWAKE_INTENTS } from './keep-awake.js';
import { READ_INTENTS } from './read.js';
import { SERVICES_INTENTS } from './services.js';
import { SETUP_INTENTS } from './setup.js';
import { WORKSPACE_INTENTS } from './workspace.js';

export const INTENTS = {
  ...CREW_INTENTS,
  ...BOARD_INTENTS,
  ...WORKSPACE_INTENTS,
  ...DATA_INTENTS,
  ...READ_INTENTS,
  ...SERVICES_INTENTS,
  ...SETUP_INTENTS,
  ...KEEP_AWAKE_INTENTS,
};

export type IntentName = keyof typeof INTENTS;

export type IntentInput<N extends IntentName> = z.input<(typeof INTENTS)[N]>;

export type IntentPayload<N extends IntentName> = z.output<(typeof INTENTS)[N]>;

export const INTENT_NAMES = Object.keys(INTENTS) as IntentName[];

export const isIntentName = (name: string): name is IntentName =>
  Object.hasOwn(INTENTS, name);

export const INTENT_PATH_PREFIX = '/api/intents/';

export const intentPath = (name: IntentName): string =>
  `${INTENT_PATH_PREFIX}${name}`;

export type IntentStatus = 'applied' | 'pending';

export type IntentResult = Record<string, unknown>;

export interface IntentReply {
  intent: IntentName;
  status: IntentStatus;
  id: string | null;
  result: IntentResult | null;
}

export interface IntentIssue {
  path: PropertyKey[];
  message: string;
}

export interface IntentErrorReply {
  error: string;
  issues?: IntentIssue[];
}
