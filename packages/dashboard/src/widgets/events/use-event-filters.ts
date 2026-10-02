import { useMemo, useState, type ChangeEvent } from 'react';
import { valueOf } from '../../grid/dom.js';
import { ALL, type EventFilters } from './event-feed.js';

export type FilterChangeHandler = (
  event: ChangeEvent<HTMLSelectElement>,
) => void;

export interface EventFilterState {
  filters: EventFilters;
  handleProjectChange: FilterChangeHandler;
  handleKindChange: FilterChangeHandler;
}

export const useEventFilters = (): EventFilterState => {
  const [filters, setFilters] = useState<EventFilters>({
    project: ALL,
    kind: ALL,
  });
  const handlers = useMemo(() => {
    const choose =
      (field: keyof EventFilters): FilterChangeHandler =>
      (event) => {
        const value = valueOf(event.currentTarget);
        setFilters((current) => ({ ...current, [field]: value }));
      };
    return {
      handleProjectChange: choose('project'),
      handleKindChange: choose('kind'),
    };
  }, []);
  return { filters, ...handlers };
};
