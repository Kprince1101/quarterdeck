import type {
  DataPage,
  DataPathEntry,
  DataPathScope,
  WipeResult,
} from '@quarterdeck/server/intents';
import type {
  ProjectRow,
  Workspace,
  WorkspaceMode,
} from '@quarterdeck/server/stream-schema';

export interface PathView {
  key: string;
  label: string;
  path: string;
  scope: string;
  presence: string;
  exists: boolean;
}

export interface RowView {
  key: string;
  cells: string[];
}

export interface PageView {
  table: string;
  label: string;
  columns: string[];
  rows: RowView[];
  range: string;
  canPrevious: boolean;
  canNext: boolean;
}

const SCOPE_LABELS: Record<WorkspaceMode, Record<DataPathScope, string>> = {
  multi: {
    project: 'This project',
    repo: 'Repository',
    machine: 'This machine',
  },
  single: {
    project: 'Quarterdeck data',
    repo: 'Repository',
    machine: 'This machine',
  },
};

export const workspaceLine = (workspace: Workspace | null): string | null => {
  if (workspace === null) return null;
  if (workspace.mode === 'single') return `One repository at ${workspace.root}`;
  const count = workspace.projects.length;
  if (count === 1) return `1 project in ${workspace.root} (multi mode)`;
  return `${count} projects in ${workspace.root} (multi mode)`;
};

export const projectSlugOf = (projects: readonly ProjectRow[]): string | null =>
  projects[0]?.slug ?? null;

export const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const presenceOf = (exists: boolean): string => {
  if (exists) return 'present';
  return 'not created yet';
};

export const pathViews = (
  paths: readonly DataPathEntry[],
  mode: WorkspaceMode = 'multi',
): PathView[] =>
  paths.map(({ label, path, scope, exists }) => ({
    key: `${scope}:${path}`,
    label,
    path,
    scope: SCOPE_LABELS[mode][scope],
    presence: presenceOf(exists),
    exists,
  }));

export const rangeOf = ({ offset, rows, total }: DataPage): string => {
  if (total === 0) return 'No rows';
  if (rows.length === 0) return `Past the last of ${total} rows`;
  return `${offset + 1}–${offset + rows.length} of ${total}`;
};

const rowViews = ({ columns, rows, offset }: DataPage): RowView[] => {
  const idColumn = columns.indexOf('id');
  return rows.map((row, at) => {
    const cells = row.map(formatCell);
    return { key: cells[idColumn] ?? `row-${offset + at}`, cells };
  });
};

export const pageView = (page: DataPage): PageView => ({
  table: page.table,
  label: `${page.table} rows`,
  columns: page.columns,
  rows: rowViews(page),
  range: rangeOf(page),
  canPrevious: page.offset > 0,
  canNext: page.offset + page.limit < page.total,
});

const listOf = (items: readonly string[]): string => {
  if (items.length === 0) return 'nothing';
  return items.join(', ');
};

export const wipeSummary = ({ wiped, stopped }: WipeResult): string => {
  const summary = `Wiped ${listOf(wiped)}.`;
  if (stopped.length === 0) return summary;
  const agents = stopped.map(({ project, agent }) => `${agent} (${project})`);
  return `${summary} Stopped ${listOf(agents)} first.`;
};

export const previousOffset = (offset: number, limit: number): number =>
  Math.max(0, offset - limit);
