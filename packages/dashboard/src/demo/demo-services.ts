import { forgeTerms } from '@quarterdeck/rules/forges';
import { MACHINE_SERVICES_PATH } from '@quarterdeck/rules/services';
import type { Tracker } from '@quarterdeck/rules/schemas';
import type {
  IntentPayload,
  ServiceSource,
  ServicesReadResult,
} from '@quarterdeck/server/intents';
import { DEMO_FORGE } from './demo-seed.js';

export const DEMO_FORGE_HOST = 'github.com';

interface StoredServices {
  tracker: Tracker | null;
  publishes: boolean | null;
}

export interface DemoServices {
  read: () => ServicesReadResult;
  set: (input: IntentPayload<'services.set'>) => StoredServices;
}

const sourceOf = (value: unknown): ServiceSource => {
  if (value === null) return 'default';
  return 'project';
};

const chosen = <T>(next: T | undefined, current: T): T => {
  if (next === undefined) return current;
  return next;
};

export const createDemoServices = (): DemoServices => {
  let stored: StoredServices = { tracker: null, publishes: null };
  const { cli, name } = forgeTerms(DEMO_FORGE);
  return {
    read: () => ({
      forge: { forge: DEMO_FORGE, host: DEMO_FORGE_HOST, cli, name },
      forgeError: null,
      tracker: stored.tracker,
      trackerFrom: sourceOf(stored.tracker),
      publishes: stored.publishes ?? false,
      publishesFrom: sourceOf(stored.publishes),
      rulesPath: MACHINE_SERVICES_PATH,
    }),
    set: (input) => {
      stored = {
        tracker: chosen(input.tracker, stored.tracker),
        publishes: chosen(input.publishes, stored.publishes),
      };
      return stored;
    },
  };
};
