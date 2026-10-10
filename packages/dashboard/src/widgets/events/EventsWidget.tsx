import type { JSX } from 'react';
import { defineWidget } from '../registry.js';
import type { FeedRow, FilterOption } from './event-feed.js';
import './events.css';
import type { FilterChangeHandler } from './use-event-filters.js';
import { useEventsWidget } from './use-events-widget.js';

interface FilterSelectProps {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: FilterChangeHandler;
}

const FilterSelect = ({
  label,
  value,
  options,
  onChange,
}: FilterSelectProps) => (
  <label className="qd-event-filter">
    <span>{label}</span>
    <select value={value} onChange={onChange}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

interface EventListProps {
  rows: FeedRow[];
  showsProjects: boolean;
}

const EventList = ({ rows, showsProjects }: EventListProps) => (
  <ol className="qd-event-list">
    {rows.map((row) => (
      <li key={row.id} data-event-id={row.id}>
        <code>{row.kind}</code>
        {showsProjects && (
          <span className="qd-event-project">{row.project}</span>
        )}
        <time dateTime={row.createdAt} title={row.createdAt}>
          {row.age}
        </time>
      </li>
    ))}
  </ol>
);

interface EventFeedBodyProps {
  rows: FeedRow[];
  showsProjects: boolean;
  isEmpty: boolean;
  isFilteredOut: boolean;
}

const EventFeedBody = ({
  rows,
  showsProjects,
  isEmpty,
  isFilteredOut,
}: EventFeedBodyProps) => {
  if (isEmpty) return <p className="qd-empty">No events yet.</p>;
  if (isFilteredOut) {
    return <p className="qd-empty">No events match these filters.</p>;
  }
  return <EventList rows={rows} showsProjects={showsProjects} />;
};

export const EventsWidget = (): JSX.Element => {
  const {
    rows,
    projectOptions,
    kindOptions,
    isEmpty,
    isFilteredOut,
    filters,
    showsProjects,
    handleProjectChange,
    handleKindChange,
  } = useEventsWidget();
  return (
    <div className="qd-events">
      <div className="qd-event-filters">
        {showsProjects && (
          <FilterSelect
            label="Project"
            value={filters.project}
            options={projectOptions}
            onChange={handleProjectChange}
          />
        )}
        <FilterSelect
          label="Kind"
          value={filters.kind}
          options={kindOptions}
          onChange={handleKindChange}
        />
      </div>
      <EventFeedBody
        rows={rows}
        showsProjects={showsProjects}
        isEmpty={isEmpty}
        isFilteredOut={isFilteredOut}
      />
    </div>
  );
};

export default defineWidget({
  type: 'events',
  title: 'Events',
  component: EventsWidget,
  size: { w: 8, h: 12 },
  minSize: { w: 3, h: 3 },
});
