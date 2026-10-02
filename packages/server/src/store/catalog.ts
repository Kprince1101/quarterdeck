import type { Queryable } from './db.js';
import { openPostgres } from './postgres.js';
import { STORE_TABLES } from './store.js';

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const hasProjectsTable = async (db: Queryable): Promise<boolean> => {
  const { rows } = await db.query<{ found: boolean }>(
    `select to_regclass('projects') is not null as found`,
  );
  return rows[0]?.found ?? false;
};

const projectScopedTables = async (tx: Queryable): Promise<string[]> => {
  const { rows } = await tx.query<{ name: string }>(
    `select table_name::text as name from information_schema.columns
     where table_schema = current_schema() and column_name = 'project_id'
       and table_name = any($1::text[])
     order by table_name`,
    [STORE_TABLES],
  );
  return rows.map((row) => row.name);
};

export const deleteProjectRows = async (
  tx: Queryable,
  projectId: string,
): Promise<void> => {
  const tables = await projectScopedTables(tx);
  await tables.reduce(async (previous, table) => {
    await previous;
    await tx.query(`delete from ${quoteIdent(table)} where project_id = $1`, [
      projectId,
    ]);
  }, Promise.resolve());
  await tx.query('delete from projects where id = $1', [projectId]);
};

export const listProjectSlugs = async (db: Queryable): Promise<string[]> => {
  if (!(await hasProjectsTable(db))) return [];
  const { rows } = await db.query<{ slug: string }>(
    'select slug from projects order by slug',
  );
  return rows.map((row) => row.slug);
};

export const projectRowExists = async (
  db: Queryable,
  project: string,
): Promise<boolean> => {
  if (!(await hasProjectsTable(db))) return false;
  const { rows } = await db.query('select 1 from projects where slug = $1', [
    project,
  ]);
  return rows.length > 0;
};

export const wipePostgresProject = async (
  url: string,
  project: string,
): Promise<boolean> => {
  const { db } = await openPostgres(url, project);
  try {
    if (!(await hasProjectsTable(db))) return false;
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'select id from projects where slug = $1',
        [project],
      );
      const [row] = rows;
      if (!row) return false;
      await deleteProjectRows(tx, row.id);
      return true;
    });
  } finally {
    await db.close();
  }
};
