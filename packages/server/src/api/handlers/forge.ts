import { RulesError, UnknownForgeError, forgeTerms } from '@quarterdeck/rules';
import { projectForge } from '../../gate/index.js';
import type { ForgeReadResult } from '../../intents/index.js';
import type { IntentHandler } from '../context.js';
import { conflict } from '../http-error.js';
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
