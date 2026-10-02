import { useMemo } from 'react';
import { usageView, type UsageView } from './usage-model.js';
import { useUsageRead } from './use-usage-read.js';

export interface UsageWidgetView {
  view: UsageView | null;
  error: string | null;
}

export const useUsageWidget = (): UsageWidgetView => {
  const { read, error } = useUsageRead();
  const view = useMemo(() => read && usageView(read), [read]);
  return { view, error };
};
