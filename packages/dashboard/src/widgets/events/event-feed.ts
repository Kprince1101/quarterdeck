import type {
  ProjectRow,
  StreamEvent,
} from '@quarterdeck/server/stream-schema';

export const ALL = '';

export const JUST_NOW = 'just now';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface EventFilters {
  project: string;
  kind: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FeedRow {
  id: number;
  kind: string;
  project: string;
  createdAt: string;
  age: string;
}

export interface EventFeed {
  rows: FeedRow[];
  projectOptions: FilterOption[];
  kindOptions: FilterOption[];
  isEmpty: boolean;
  isFilteredOut: boolean;
}

export interface EventFeedSource {
  events: readonly StreamEvent[];
  projects: readonly ProjectRow[];
  filters: EventFilters;
  now: number;
}

export const relativeTime = (createdAt: string, now: number): string => {
  const elapsed = now - Date.parse(createdAt);
  if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) return JUST_NOW;
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
};

export const matchesFilters = (
  event: StreamEvent,
  { project, kind }: EventFilters,
): boolean =>
  (project === ALL || event.projectId === project) &&
  (kind === ALL || event.kind === kind);

export const newestFirst = (events: readonly StreamEvent[]): StreamEvent[] =>
  events.toSorted((a, b) => b.id - a.id);

const projectNames = (
  projects: readonly ProjectRow[],
): ReadonlyMap<string, string> =>
  new Map(projects.map(({ id, name }) => [id, name]));

const distinct = (values: readonly string[], selected: string): string[] =>
  [...new Set([...values, selected])].filter((value) => value !== ALL);

export const projectOptions = (
  events: readonly StreamEvent[],
  projects: readonly ProjectRow[],
  selected: string,
): FilterOption[] => {
  const names = projectNames(projects);
  const ids = distinct(
    [...projects.map(({ id }) => id), ...events.map((e) => e.projectId)],
    selected,
  );
  return [
    { value: ALL, label: 'All projects' },
    ...ids
      .map((id) => ({ value: id, label: names.get(id) ?? id }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  ];
};

export const kindOptions = (
  events: readonly StreamEvent[],
  selected: string,
): FilterOption[] => [
  { value: ALL, label: 'All kinds' },
  ...distinct(
    events.map(({ kind }) => kind),
    selected,
  )
    .toSorted((a, b) => a.localeCompare(b))
    .map((kind) => ({ value: kind, label: kind })),
];

export const eventFeed = ({
  events,
  projects,
  filters,
  now,
}: EventFeedSource): EventFeed => {
  const names = projectNames(projects);
  const rows = newestFirst(
    events.filter((event) => matchesFilters(event, filters)),
  ).map((event) => ({
    id: event.id,
    kind: event.kind,
    project: names.get(event.projectId) ?? event.projectId,
    createdAt: event.createdAt,
    age: relativeTime(event.createdAt, now),
  }));
  return {
    rows,
    projectOptions: projectOptions(events, projects, filters.project),
    kindOptions: kindOptions(events, filters.kind),
    isEmpty: events.length === 0,
    isFilteredOut: events.length > 0 && rows.length === 0,
  };
};
