import {
  DEFAULT_PRESET,
  PRESET_NAMES,
  presetNameSchema,
  type PresetName,
} from '@quarterdeck/server/layouts';
import { useState, type ChangeEvent } from 'react';
import { valueOf } from '../grid/dom.js';
import { PRESET_TITLES } from './constants.js';

export interface PresetOption {
  name: PresetName;
  title: string;
}

export interface PresetPicker {
  presets: PresetOption[];
  chosenPreset: PresetName;
  handleChoosePreset: (event: ChangeEvent<HTMLSelectElement>) => void;
}

export const PRESET_OPTIONS: PresetOption[] = PRESET_NAMES.map((name) => ({
  name,
  title: PRESET_TITLES[name],
}));

export const usePresetPicker = (): PresetPicker => {
  const [chosenPreset, setChosenPreset] = useState<PresetName>(DEFAULT_PRESET);
  return {
    presets: PRESET_OPTIONS,
    chosenPreset,
    handleChoosePreset: (event) => {
      const picked = presetNameSchema.safeParse(valueOf(event.currentTarget));
      if (picked.success) setChosenPreset(picked.data);
    },
  };
};
