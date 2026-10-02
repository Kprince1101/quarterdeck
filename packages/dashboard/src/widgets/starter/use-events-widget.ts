import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { useDeck } from '../../deck/deck.js';

export interface EventsWidgetView {
  newestFirst: StreamEvent[];
  isEmpty: boolean;
}

export const useEventsWidget = (): EventsWidgetView => {
  const { events } = useDeck().stream;
  return { newestFirst: events.toReversed(), isEmpty: events.length === 0 };
};
