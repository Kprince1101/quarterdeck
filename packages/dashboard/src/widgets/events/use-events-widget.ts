import { useMemo } from 'react';
import { useDeck } from '../../deck/deck.js';
import { eventFeed, type EventFeed } from './event-feed.js';
import { useEventFilters, type EventFilterState } from './use-event-filters.js';
import { useNow } from './use-now.js';

export interface EventsWidgetView extends EventFeed, EventFilterState {}

export const useEventsWidget = (): EventsWidgetView => {
  const { events, tables } = useDeck().stream;
  const filterState = useEventFilters();
  const now = useNow();
  const { filters } = filterState;
  const feed = useMemo(
    () => eventFeed({ events, projects: tables.projects, filters, now }),
    [events, tables.projects, filters, now],
  );
  return { ...feed, ...filterState };
};
