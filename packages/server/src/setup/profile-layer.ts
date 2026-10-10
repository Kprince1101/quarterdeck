import { ruleLayerPaths } from '@quarterdeck/rules';
import type { ApiContext } from '../api/context.js';
import { dispatchIntent } from '../api/dispatch.js';
import { INTENTS } from '../intents/index.js';
import { readJsonLayer } from './runtime-layer.js';

export const machineProfileLayer = (homeDir: string): string => {
  const [machine] = ruleLayerPaths('profile', { homeDir }).local;
  if (machine === undefined) throw new Error('profile has no machine layer');
  return machine;
};

export const saveMachineProfile = async (
  ctx: Pick<ApiContext, 'stores' | 'homeDir'>,
  profile: string,
): Promise<string> => {
  const path = machineProfileLayer(ctx.homeDir);
  const layer = { ...(await readJsonLayer(path)), profile };
  await dispatchIntent(
    { stores: ctx.stores, homeDir: ctx.homeDir },
    'rules.write',
    INTENTS['rules.write'].parse({
      scope: 'machine',
      name: 'profile',
      content: `${JSON.stringify(layer, null, 2)}\n`,
    }),
  );
  return path;
};
