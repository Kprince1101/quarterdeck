import { CliError } from './io.js';

export interface HarnessSession {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

export type HarnessConnector = (url: string) => Promise<HarnessSession>;

export interface HarnessProject {
  id: string;
  name: string;
  repos: string[];
  reviewer: string | null;
  autoMerge: boolean;
  copilotReview: boolean;
  paused: boolean;
  archived: boolean;
}

export interface HarnessItem {
  id: string;
  project: string;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  dependsOn: string[];
  parentId: string | null;
  prUrl: string | null;
  prState: string | null;
  context: unknown;
}

export interface HarnessNote {
  id: string;
  project: string | null;
  text: string;
  pinned: boolean;
  createdAt: Date;
}

export interface HarnessSnapshot {
  projects: HarnessProject[];
  items: HarnessItem[];
  notes: HarnessNote[];
}

type JsonRow = Record<string, unknown>;

export const READ_ONLY_SETUP = 'set default_transaction_read_only = on';

export const READ_ONLY_BEGIN =
  'begin transaction isolation level repeatable read read only';

const READ_ONLY_CHECK = `select current_setting('default_transaction_read_only') as "readOnly"`;

const PROJECTS_SQL =
  'select to_jsonb(p) as row from harness_projects p order by p.name';

const ITEMS_SQL = `select to_jsonb(d) as row from docket_items d
  where d.status <> 'completed' order by d.created_at, d.id`;

const NOTES_SQL = `select to_jsonb(n) as row from harness_notebook n
  where n.status = 'active' order by n.created_at, n.id`;

const malformed = (table: string, key: string): CliError =>
  new CliError(
    `A Harness ${table} row has no usable ${key}; nothing was read.`,
  );

const text = (row: JsonRow, table: string, key: string): string => {
  const value = row[key];
  if (typeof value === 'string' && value !== '') return value;
  throw malformed(table, key);
};

const optionalText = (row: JsonRow, key: string): string | null => {
  const value = row[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
};

const flag = (row: JsonRow, key: string): boolean => row[key] === true;

const texts = (row: JsonRow, key: string): string[] => {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
};

const time = (row: JsonRow, table: string, key: string): Date => {
  const value = new Date(text(row, table, key));
  if (Number.isNaN(value.getTime())) throw malformed(table, key);
  return value;
};

const projectOf = (row: JsonRow): HarnessProject => ({
  id: text(row, 'harness_projects', 'id'),
  name: text(row, 'harness_projects', 'name'),
  repos: texts(row, 'repos'),
  reviewer: optionalText(row, 'reviewer'),
  autoMerge: flag(row, 'auto_merge'),
  copilotReview: flag(row, 'copilot_review'),
  paused: flag(row, 'paused'),
  archived: row['archived_at'] !== null && row['archived_at'] !== undefined,
});

const itemOf = (row: JsonRow): HarnessItem => ({
  id: text(row, 'docket_items', 'id'),
  project: text(row, 'docket_items', 'project'),
  title: text(row, 'docket_items', 'title'),
  description: optionalText(row, 'description')?.trim() ?? '',
  status: text(row, 'docket_items', 'status'),
  priority: optionalText(row, 'priority'),
  dependsOn: texts(row, 'depends_on'),
  parentId: optionalText(row, 'parent_id'),
  prUrl: optionalText(row, 'pr_url'),
  prState: optionalText(row, 'pr_state'),
  context: row['context'] ?? null,
});

const noteOf = (row: JsonRow): HarnessNote => ({
  id: text(row, 'harness_notebook', 'id'),
  project: optionalText(row, 'project'),
  text: text(row, 'harness_notebook', 'text'),
  pinned: flag(row, 'pinned'),
  createdAt: time(row, 'harness_notebook', 'created_at'),
});

const jsonRows = async (
  session: HarnessSession,
  sql: string,
): Promise<JsonRow[]> => {
  const { rows } = await session.query<{ row: JsonRow }>(sql);
  return rows.map(({ row }) => row);
};

const turnReadOnly = async (session: HarnessSession): Promise<void> => {
  await session.query(READ_ONLY_SETUP);
  const { rows } = await session.query<{ readOnly: string }>(READ_ONLY_CHECK);
  if (rows[0]?.readOnly === 'on') return;
  throw new CliError(
    'The Harness connection did not turn read-only; nothing was read.',
  );
};

export const readHarness = async (
  session: HarnessSession,
): Promise<HarnessSnapshot> => {
  await turnReadOnly(session);
  await session.query(READ_ONLY_BEGIN);
  try {
    const projects = (await jsonRows(session, PROJECTS_SQL)).map(projectOf);
    const items = (await jsonRows(session, ITEMS_SQL)).map(itemOf);
    const notes = (await jsonRows(session, NOTES_SQL)).map(noteOf);
    await session.query('commit');
    return { projects, items, notes };
  } catch (err) {
    await session.query('rollback').catch(() => undefined);
    throw err;
  }
};
