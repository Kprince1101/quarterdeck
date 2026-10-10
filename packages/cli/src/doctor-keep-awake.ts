import { keepAwakeSupport, type KeepAwakeSupport } from '@quarterdeck/server';
import type { DoctorCheck } from './doctor.js';
import type { CliIo } from './io.js';

export const KEEP_AWAKE_CHECK = 'keep-awake';

export const KEEP_AWAKE_OFF = "The dashboard's keep-awake control is off.";

export interface KeepAwakeCheckOptions {
  platform?: NodeJS.Platform;
}

const stateOf = (support: KeepAwakeSupport): string => {
  if (support.available) {
    return `${support.tool} found; the dashboard can keep this computer from sleeping`;
  }
  return `${support.reason} ${KEEP_AWAKE_OFF}`;
};

export const checkKeepAwake = async (
  io: CliIo,
  { platform = process.platform }: KeepAwakeCheckOptions = {},
): Promise<DoctorCheck> => ({
  name: KEEP_AWAKE_CHECK,
  state: stateOf(await keepAwakeSupport({ platform, env: io.env })),
  fixes: [],
});
