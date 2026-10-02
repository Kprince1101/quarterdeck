import { useMemo } from 'react';
import { useDeck } from '../../deck/deck.js';
import { useNow } from '../../lib/use-now.js';
import { buildUsage, type UsageModel } from './usage-model.js';
import { useWindowCap, type WindowCap } from './use-window-cap.js';

export interface UsageWidgetView extends UsageModel, WindowCap {}

export const useUsageWidget = (): UsageWidgetView => {
  const { turns } = useDeck().stream.tables;
  const now = useNow();
  const windowCap = useWindowCap();
  const { cap } = windowCap;
  const usage = useMemo(() => buildUsage(turns, cap, now), [turns, cap, now]);
  return { ...usage, ...windowCap };
};
