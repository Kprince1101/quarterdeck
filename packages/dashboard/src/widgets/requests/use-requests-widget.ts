import { useMemo } from 'react';
import { requestsView, type RequestsView } from './requests-model.js';
import { useRequestsRead } from './use-requests-read.js';

export interface RequestsWidgetView {
  view: RequestsView | null;
  error: string | null;
}

export const useRequestsWidget = (): RequestsWidgetView => {
  const { projects, error, now } = useRequestsRead();
  const view = useMemo(
    () => projects && requestsView(projects, now),
    [projects, now],
  );
  return { view, error };
};
