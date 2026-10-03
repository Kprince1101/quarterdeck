import type { ServicesReadResult } from '@quarterdeck/server/intents';
import {
  createIntentClient,
  type IntentClient,
} from '../../../src/api/index.js';

export const SERVICES_RULES_PATH =
  '/home/me/.quarterdeck/rules.local.services.json';

export const servicesRead = (
  overrides: Partial<ServicesReadResult> = {},
): ServicesReadResult => ({
  forge: { forge: 'github', host: 'github.com', cli: 'gh', name: 'GitHub' },
  forgeError: null,
  tracker: null,
  trackerFrom: 'default',
  publishes: false,
  publishesFrom: 'default',
  rulesPath: SERVICES_RULES_PATH,
  ...overrides,
});

export const servicesAnswer = (
  read: ServicesReadResult = servicesRead(),
): Response =>
  new Response(
    JSON.stringify({
      intent: 'services.read',
      status: 'applied',
      id: null,
      result: read,
    }),
    { status: 200 },
  );

export const servicesOnlyIntents = (): IntentClient =>
  createIntentClient({
    baseUrl: 'http://deck.test',
    fetch: () => Promise.resolve(servicesAnswer()),
  });
