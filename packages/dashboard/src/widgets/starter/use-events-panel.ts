import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { useDeck } from '../../deck/deck.js';

export interface EventsPanelView {
  newestFirst: StreamEvent[];
  isEmpty: boolean;
}

export const useEventsPanel = (): EventsPanelView => {
  const { events } = useDeck().stream;
  return { newestFirst: events.toReversed(), isEmpty: events.length === 0 };
};
