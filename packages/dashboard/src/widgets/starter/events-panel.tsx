import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { Panel } from '../../shell/shell.js';
import { useEventsPanel } from './use-events-panel.js';

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

export const EventsPanel = () => {
  const { newestFirst, isEmpty } = useEventsPanel();
  return (
    <Panel title="Events">
      <EventList events={newestFirst} isEmpty={isEmpty} />
    </Panel>
  );
};
