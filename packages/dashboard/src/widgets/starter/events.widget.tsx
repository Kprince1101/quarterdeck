import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { defineWidget } from '../registry.js';
import { useEventsWidget } from './use-events-widget.js';

interface EventListProps {
  events: StreamEvent[];
  isEmpty: boolean;
}

const EventList = ({ events, isEmpty }: EventListProps) => {
  if (isEmpty) return <p className="qd-empty">No events yet.</p>;
  return (
    <ol className="qd-event-list" reversed>
      {events.map((event) => (
        <li key={event.id} data-event-id={event.id}>
          <code>{event.kind}</code>
          <time dateTime={event.createdAt}>{event.createdAt}</time>
        </li>
      ))}
    </ol>
  );
};

export const EventsWidget = () => {
  const { newestFirst, isEmpty } = useEventsWidget();
  return <EventList events={newestFirst} isEmpty={isEmpty} />;
};

export default defineWidget({
  type: 'events',
  title: 'Events',
  component: EventsWidget,
  size: { w: 8, h: 12 },
  minSize: { w: 3, h: 3 },
});
