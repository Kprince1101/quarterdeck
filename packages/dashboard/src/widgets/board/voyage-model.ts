import type {
  SnapshotTables,
  TicketRow,
  VoyageRow,
} from '@quarterdeck/server/stream-schema';

const HELD_TICKET_STATUSES: ReadonlySet<TicketRow['status']> = new Set([
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
  'blocked',
]);

export interface GlobalVoyage {
  number: number;
  label: string;
  goal: string;
  projects: string[];
  reopenCount: number;
  isCountPartial: boolean;
}

const openRows = (voyages: readonly VoyageRow[]): VoyageRow[] => {
  const open = voyages.filter(({ status }) => status !== 'ended');
  const newest = Math.max(0, ...open.map(({ number }) => number));
  return open.filter(({ number }) => number === newest);
};

const voyageProjects = (
  rows: readonly VoyageRow[],
  tables: SnapshotTables,
): string[] => {
  const slugs = new Map(tables.projects.map(({ id, slug }) => [id, slug]));
  const named = rows.flatMap((row) => [
    ...row.projects,
    slugs.get(row.projectId) ?? '',
  ]);
  return [...new Set(named.filter((slug) => slug !== ''))].toSorted();
};

const reopenCountOf = (
  rows: readonly VoyageRow[],
  tables: SnapshotTables,
): number => {
  const voyageIds = new Set(rows.map(({ id }) => id));
  const builders = new Set(
    tables.agents
      .filter(
        ({ role, voyageId }) =>
          role === 'builder' && voyageIds.has(voyageId ?? ''),
      )
      .map(({ id }) => id),
  );
  return tables.tickets.filter(
    ({ status, assigneeId }) =>
      HELD_TICKET_STATUSES.has(status) && builders.has(assigneeId ?? ''),
  ).length;
};

export const globalVoyage = (tables: SnapshotTables): GlobalVoyage | null => {
  const rows = openRows(tables.voyages);
  const [row] = rows;
  if (row === undefined) return null;
  const projects = voyageProjects(rows, tables);
  const streamed = new Set(tables.projects.map(({ slug }) => slug));
  return {
    number: row.number,
    label: `Voyage ${row.number} · ${row.status}`,
    goal: row.goal,
    projects,
    reopenCount: reopenCountOf(rows, tables),
    isCountPartial: projects.some((slug) => !streamed.has(slug)),
  };
};

const ticketCount = (count: number): string => {
  if (count === 1) return '1 ticket';
  return `${count} tickets`;
};

const countScope = (voyage: GlobalVoyage | null): string => {
  if (voyage?.isCountPartial !== true) return '';
  return ' here, and its tickets in the other projects';
};

export const killAllLabel = (voyage: GlobalVoyage | null): string =>
  `Kill all? This ends the voyage and reopens ${ticketCount(voyage?.reopenCount ?? 0)}${countScope(voyage)}`;
