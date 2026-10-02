import type { PresetName } from '@quarterdeck/server/layouts';

export const DASHBOARD_LAYOUT = 'dashboard';

export const LAYOUT_SAVE_DELAY_MS = 300;

export const PRESET_TITLES: Record<PresetName, string> = {
  default: 'Default',
  ops: 'Ops',
  minimal: 'Minimal',
};
