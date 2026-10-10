import type { KeepAwakeIntentName } from '../../intents/index.js';
import { KeepAwakeError, type KeepAwake } from '../../keep-awake/index.js';
import type { KeepAwakeState } from '../../stream/schema.js';
import type { ApiContext, IntentHandlers } from '../context.js';
import { conflict } from '../http-error.js';
import { unrecorded } from '../record.js';

export const KEEP_AWAKE_NOT_SERVED =
  'Keep-awake runs only under quarterdeck up.';

const keepAwakeOf = (ctx: ApiContext): KeepAwake => {
  if (ctx.keepAwake === undefined) throw conflict(KEEP_AWAKE_NOT_SERVED);
  return ctx.keepAwake;
};

const asConflict = async (
  work: () => Promise<KeepAwakeState>,
): Promise<KeepAwakeState> => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof KeepAwakeError) throw conflict(err.message);
    throw err;
  }
};

export const KEEP_AWAKE_HANDLERS: IntentHandlers<KeepAwakeIntentName> = {
  'keepAwake.start': async (ctx, input, name) => {
    const keepAwake = keepAwakeOf(ctx);
    const state = await asConflict(() => keepAwake.start(input));
    return unrecorded(name, { keepAwake: state });
  },
  'keepAwake.stop': async (ctx, _input, name) => {
    const keepAwake = keepAwakeOf(ctx);
    const state = await asConflict(() => keepAwake.stop());
    return unrecorded(name, { keepAwake: state });
  },
};
