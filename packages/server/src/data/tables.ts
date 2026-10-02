import type { DataPage, TableCount } from '../intents/index.js';
import {
  STORE_TABLES,
  tableScope,
  type Queryable,
  type StoreTable,
} from '../store/index.js';

export interface PageRequest {
  offset: number;
  limit: number;
}

const PAGE_ORDER: Record<StoreTable, string> = {
  projects: 'created_at desc',
  rounds: 'number desc',
  agents: 'created_at desc',
  tickets: 'created_at desc',
  cards: 'created_at desc',
  turns: 'id desc',
  events: 'id desc',
  notebook: 'created_at desc',
  charter_proposals: 'created_at desc',
  budget: 'updated_at desc',
  layouts: 'name',
  intents: 'created_at desc',
};

export const isStoreTable = (name: string): name is StoreTable =>
  (STORE_TABLES as readonly string[]).includes(name);

const countRows = async (
  db: Queryable,
  projectId: string,
  table: StoreTable,
): Promise<number> => {
  const { rows } = await db.query<{ total: number }>(
    `select count(*)::int as total from ${table} where ${tableScope(table)}`,
    [projectId],
  );
  return rows[0]?.total ?? 0;
};

export const countTables = async (
  db: Queryable,
  projectId: string,
): Promise<TableCount[]> =>
  Promise.all(
    STORE_TABLES.map(async (table) => ({
      table,
      rows: await countRows(db, projectId, table),
    })),
  );

const tableColumns = async (
  db: Queryable,
  table: StoreTable,
): Promise<string[]> => {
  const { rows } = await db.query<{ name: string }>(
    `select column_name::text as name from information_schema.columns
     where table_schema = current_schema() and table_name = $1
     order by ordinal_position`,
    [table],
  );
  return rows.map((row) => row.name);
};

const toCell = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
};

export const readTablePage = async (
  db: Queryable,
  projectId: string,
  table: StoreTable,
  { offset, limit }: PageRequest,
): Promise<DataPage> => {
  const columns = await tableColumns(db, table);
  const total = await countRows(db, projectId, table);
  const { rows } = await db.query<Record<string, unknown>>(
    `select * from ${table} where ${tableScope(table)}
     order by ${PAGE_ORDER[table]}, id
     limit $2 offset $3`,
    [projectId, limit, offset],
  );
  return {
    table,
    offset,
    limit,
    total,
    columns,
    rows: rows.map((row) =>
      columns.map((column) => toCell(row[column])),
    ) as DataPage['rows'],
  };
};
