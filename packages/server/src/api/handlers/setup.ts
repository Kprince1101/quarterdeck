import type { SetupIntentName } from '../../intents/index.js';
import { detectSetupFolder, saveSetup } from '../../setup/save.js';
import { needsSetup } from '../../setup/paths.js';
import type { SetupSignIns } from '../../setup/sign-ins.js';
import { setupTools } from '../../setup/tools.js';
import type { ApiContext, IntentHandlers } from '../context.js';
import { HttpError } from '../http-error.js';
import { unrecorded } from '../record.js';

const NOT_AVAILABLE = 501;

const signInsOf = (ctx: ApiContext): SetupSignIns => {
  if (ctx.setupSignIns !== undefined) return ctx.setupSignIns;
  throw new HttpError(NOT_AVAILABLE, 'Sign-in runs only under quarterdeck up');
};

export const SETUP_HANDLERS: IntentHandlers<SetupIntentName> = {
  'setup.read': async (ctx, _input, name) =>
    unrecorded(name, {
      needsSetup: await needsSetup(ctx),
      signIns: ctx.setupSignIns?.read() ?? [],
    }),
  'setup.detect': async (ctx, input, name) =>
    unrecorded(name, { ...(await detectSetupFolder(ctx, input.path)) }),
  'setup.tools': async (ctx, input, name) =>
    unrecorded(name, { ...(await setupTools(ctx, input.root)) }),
  'setup.sign_in': async (ctx, input, name) =>
    unrecorded(name, { signIn: signInsOf(ctx).start(input.tool) }),
  'setup.save': async (ctx, input, name) =>
    unrecorded(name, { ...(await saveSetup(ctx, input)) }),
};
