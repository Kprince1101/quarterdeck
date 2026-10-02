import type { Db, LiveFeed, Queryable } from './db.js';
import { reporter } from './events.js';

export const CHANGES_CHANNEL = 'quarterdeck_changes';

export const WATCHED_TABLES = [
  'projects',
  'rounds',
  'agents',
  'tickets',
  'cards',
  'turns',
  'notebook',
  'notebook_proposals',
  'charter_proposals',
  'budget',
  'layouts',
] as const;

export type WatchedTable = (typeof WATCHED_TABLES)[number];

export type ChangeOp = 'insert' | 'update' | 'delete';

export type Row = Record<string, unknown>;

export interface TableChange {
  table: WatchedTable;
  op: ChangeOp;
  id: string | number;
  row: Row | null;
}

export type ChangeHandler = (change: TableChange) => void | Promise<void>;

export interface WatchOptions {
  onError?: (err: unknown) => void;
}

export interface Watcher {
  close: () => Promise<void>;
}

export interface ChangeWatcher extends Watcher, LiveFeed {}

interface Notice {
  table: string;
  op: ChangeOp;
  id: string | number;
  project_id: string | null;
}

const TURN_COLUMNS = `id, agent_id, ticket_id, seq, stop_reason, input_tokens,
  output_tokens, transcript_path, started_at, ended_at`;

const ORDER: Record<WatchedTable, string> = {
  projects: 'created_at',
  rounds: 'number',
  agents: 'created_at',
  tickets: 'created_at',
  cards: 'created_at',
  turns: 'id',
  notebook: 'created_at',
  notebook_proposals: 'created_at',
  charter_proposals: 'created_at',
  budget: 'updated_at',
  layouts: 'name',
};

const scope = (table: WatchedTable): string => {
  if (table === 'projects') return 'id = $1';
  if (table === 'turns') {
    return 'agent_id in (select id from agents where project_id = $1)';
  }
  return 'project_id = $1';
};

const isWatched = (table: string): table is WatchedTable =>
  (WATCHED_TABLES as readonly string[]).includes(table);

const camelKey = (key: string): string =>
  key.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const camelRow = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camelKey(key), value]),
  );

const AGENT_COLUMNS = `id, project_id, round_id, name, role, runtime, status,
  session_id, worktree_path, created_at, updated_at, ended_at`;

const columns = (table: WatchedTable): string => {
  if (table === 'turns') return TURN_COLUMNS;
  if (table === 'agents') return AGENT_COLUMNS;
  return '*';
};

const latestTurns = (perAgent: number): string =>
  `select ${TURN_COLUMNS} from (
     select *, row_number() over (partition by agent_id order by id desc) as recent
     from turns where ${scope('turns')}
   ) latest
   where recent <= ${perAgent}
   order by id`;

export interface ReadRowsOptions {
  turnsPerAgent?: number;
}

export const readRows = async (
  db: Queryable,
  projectId: string,
  table: WatchedTable,
  options: ReadRowsOptions = {},
): Promise<Row[]> => {
  const { turnsPerAgent } = options;
  let sql = `select ${columns(table)} from ${table} where ${scope(table)}
     order by ${ORDER[table]}, id`;
  if (table === 'turns' && turnsPerAgent !== undefined) {
    sql = latestTurns(Math.max(0, Math.trunc(turnsPerAgent)));
  }
  const { rows } = await db.query<Row>(sql, [projectId]);
  return rows.map(camelRow);
};

export const readRow = async (
  db: Queryable,
  projectId: string,
  table: WatchedTable,
  id: string | number,
): Promise<Row | null> => {
  const { rows } = await db.query<Row>(
    `select ${columns(table)} from ${table} where id = $2 and ${scope(table)}`,
    [projectId, id],
  );
  const [row] = rows;
  if (!row) return null;
  return camelRow(row);
};

export const watchChanges = async (
  db: Db,
  projectId: string,
  handler: ChangeHandler,
  options: WatchOptions = {},
): Promise<ChangeWatcher> => {
  const reportTo = reporter(options.onError);
  let failed = false;
  const report = (err: unknown): void => {
    if (!failed) reportTo(err);
  };
  let closed = false;

  const deliver = async (payload: string): Promise<void> => {
    const { table, op, id, project_id: owner } = JSON.parse(payload) as Notice;
    if (closed || !isWatched(table) || owner !== projectId) return;
    let row: Row | null = null;
    if (op !== 'delete') row = await readRow(db, projectId, table, id);
    if (closed) return;
    await handler({ table, op, id, row });
  };

  let tail: Promise<void> = Promise.resolve();
  const unlisten = await db.listen(CHANGES_CHANNEL, (payload) => {
    if (closed) return;
    tail = tail.then(() => deliver(payload)).catch(report);
  });

  const shutdown = async (): Promise<void> => {
    closed = true;
    await unlisten();
    await tail;
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= shutdown();
    return closing;
  };

  return {
    close,
    fail: (err) => {
      if (closing) return closing;
      report(err);
      failed = true;
      return close();
    },
  };
};
