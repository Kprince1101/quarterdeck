import {
  RulesError,
  UnknownForgeError,
  forgeTerms,
  ruleLayerPaths,
} from '@quarterdeck/rules';
import { getErrorMessage } from '../../lib/errors.js';
import { detectProjectForge } from '../../gate/index.js';
import type {
  ForgeService,
  ServicesIntentName,
  ServicesReadResult,
} from '../../intents/index.js';
import { loadServices } from '../../services/index.js';
import type { Store } from '../../store/index.js';
import type { IntentHandlers } from '../context.js';
import { conflict } from '../http-error.js';
import { applyInProject, findRow, unrecorded } from '../record.js';

const isRulesConfigError = (err: unknown): err is Error =>
  err instanceof UnknownForgeError || err instanceof RulesError;

interface ForgeRead {
  forge: ForgeService | null;
  forgeError: string | null;
}

const readForgeService = async (
  store: Store,
  homeDir: string,
): Promise<ForgeRead> => {
  try {
    const { forge, host } = await detectProjectForge(store, { homeDir });
    const { cli, name } = forgeTerms(forge);
    return { forge: { forge, host, cli, name }, forgeError: null };
  } catch (err) {
    if (!isRulesConfigError(err)) throw err;
    return { forge: null, forgeError: getErrorMessage(err) };
  }
};

const loadOrConflict = async (store: Store, homeDir: string) => {
  try {
    return await loadServices(store, { homeDir });
  } catch (err) {
    if (isRulesConfigError(err)) throw conflict(err.message);
    throw err;
  }
};

const jsonOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
};

export const SERVICES_HANDLERS: IntentHandlers<ServicesIntentName> = {
  'services.read': async (ctx, input, name) => {
    const store = await ctx.stores.get(input.project);
    const [services, forge] = await Promise.all([
      loadOrConflict(store, ctx.homeDir),
      readForgeService(store, ctx.homeDir),
    ]);
    const [rulesPath = ''] = ruleLayerPaths('services', {
      homeDir: ctx.homeDir,
    }).local;
    const read: ServicesReadResult = { ...services, ...forge, rulesPath };
    return unrecorded(name, read);
  },
  'services.set': (ctx, input, name) =>
    applyInProject(ctx, name, input, (tx, projectId) =>
      findRow<{ tracker: unknown; publishes: boolean | null }>(
        tx,
        `update projects set
           tracker = case when $2::boolean then $3::jsonb else tracker end,
           publishes = case when $4::boolean then $5::boolean else publishes end
         where id = $1
         returning tracker, publishes`,
        [
          projectId,
          input.tracker !== undefined,
          jsonOrNull(input.tracker),
          input.publishes !== undefined,
          input.publishes ?? null,
        ],
        `project ${input.project} not found`,
      ),
    ),
};
