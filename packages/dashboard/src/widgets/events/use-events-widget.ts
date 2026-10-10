import { useMemo } from 'react';
import {
  useDeck,
  useShowsProjects,
  useWording,
  type Wording,
} from '../../deck/DeckProvider.js';
import { useNow } from '../../lib/use-now.js';
import { eventFeed, type EventFeed } from './event-feed.js';
import { useEventFilters, type EventFilterState } from './use-event-filters.js';

export interface EventsWidgetView extends EventFeed, EventFilterState {
  showsProjects: boolean;
}

const worded = (feed: EventFeed, word: Wording): EventFeed => ({
  ...feed,
  rows: feed.rows.map((row) => ({ ...row, kind: word(row.kind) })),
  kindOptions: feed.kindOptions.map((option) => ({
    ...option,
    label: word(option.label),
  })),
});

export const useEventsWidget = (): EventsWidgetView => {
  const { events, tables } = useDeck().stream;
  const showsProjects = useShowsProjects();
  const word = useWording();
  const filterState = useEventFilters();
  const now = useNow();
  const { filters } = filterState;
  const feed = useMemo(
    () =>
      worded(
        eventFeed({ events, projects: tables.projects, filters, now }),
        word,
      ),
    [events, tables.projects, filters, now, word],
  );
  return { ...feed, ...filterState, showsProjects };
};
