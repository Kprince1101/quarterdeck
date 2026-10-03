import { RulesError, UnknownForgeError, forgeTerms } from '@quarterdeck/rules';
import { projectForge } from '../../gate/index.js';
import type {
  ForgeReadResult,
  ForgeRequestsResult,
} from '../../intents/index.js';
import type { IntentHandler } from '../context.js';
import { conflict } from '../http-error.js';
import { createOpenRequests } from '../open-requests.js';
import { unrecorded } from '../record.js';

const isForgeConfigError = (err: unknown): err is Error =>
  err instanceof UnknownForgeError || err instanceof RulesError;

export const readForge: IntentHandler<'forge.read'> = async (
  ctx,
  input,
  name,
) => {
  const store = await ctx.stores.get(input.project);
  try {
    const forge = await projectForge(store, { homeDir: ctx.homeDir });
    const read: ForgeReadResult = { forge, terms: forgeTerms(forge) };
    return unrecorded(name, read);
  } catch (err) {
    if (isForgeConfigError(err)) throw conflict(err.message);
    throw err;
  }
};

export const readOpenRequests: IntentHandler<'forge.requests'> = async (
  ctx,
  _input,
  name,
) => {
  const openRequests =
    ctx.openRequests ??
    createOpenRequests({ stores: ctx.stores, homeDir: ctx.homeDir });
  const read: ForgeRequestsResult = { projects: await openRequests.read() };
  return unrecorded(name, read);
};
