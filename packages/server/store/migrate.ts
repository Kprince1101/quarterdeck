import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';

export interface Migration {
  version: string;
  sql: string;
}

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('./migrations/', import.meta.url),
);

const MIGRATION_FILE = /^(\d{4}_[a-z0-9_]+)\.sql$/;

const CREATE_LEDGER = `create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
)`;

export const loadMigrations = async (
  dir: string = MIGRATIONS_DIR,
): Promise<Migration[]> => {
  const versions = (await readdir(dir))
    .map((file) => MIGRATION_FILE.exec(file)?.[1])
    .filter((version) => version !== undefined)
    .toSorted();
  return Promise.all(
    versions.map(async (version) => ({
      version,
      sql: await readFile(join(dir, `${version}.sql`), 'utf8'),
    })),
  );
};

const appliedVersions = async (db: PGlite): Promise<Set<string>> => {
  await db.exec(CREATE_LEDGER);
  const { rows } = await db.query<{ version: string }>(
    'select version from schema_migrations',
  );
  return new Set(rows.map((row) => row.version));
};

const applyMigration = (db: PGlite, migration: Migration): Promise<void> =>
  db.transaction(async (tx) => {
    await tx.exec(migration.sql);
    await tx.query('insert into schema_migrations (version) values ($1)', [
      migration.version,
    ]);
  });

export const migrate = async (
  db: PGlite,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> => {
  const applied = await appliedVersions(db);
  const pending = (await loadMigrations(dir)).filter(
    (migration) => !applied.has(migration.version),
  );
  await pending.reduce(
    (previous, migration) => previous.then(() => applyMigration(db, migration)),
    Promise.resolve(),
  );
  return pending.map((migration) => migration.version);
};
