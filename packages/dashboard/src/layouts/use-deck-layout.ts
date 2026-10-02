import type { GridLayout } from '@quarterdeck/server/layouts';
import { useDeck } from '../deck/DeckProvider.js';
import { usePresetPicker, type PresetPicker } from './use-preset-picker.js';
import { useLayoutSync } from './use-layout-sync.js';

export interface DeckLayoutOptions {
  saveDelayMs?: number | undefined;
}

export interface DeckLayoutView extends PresetPicker {
  initialLayout: GridLayout;
  syncedLayout: GridLayout | null;
  error: string | null;
  hasError: boolean;
  handleLayoutChange: (layout: GridLayout) => void;
  handleReset: () => void;
}

export const useDeckLayout = ({
  saveDelayMs,
}: DeckLayoutOptions = {}): DeckLayoutView => {
  const { stream, intents } = useDeck();
  const picker = usePresetPicker();
  const { resetTo, ...sync } = useLayoutSync({
    stream,
    intents,
    delayMs: saveDelayMs,
  });
  return {
    ...picker,
    ...sync,
    hasError: sync.error !== null,
    handleReset: () => resetTo(picker.chosenPreset),
  };
};
