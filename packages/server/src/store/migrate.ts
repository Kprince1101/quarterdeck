import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from './db.js';

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

const LOCK_MIGRATIONS = `select pg_advisory_xact_lock(hashtext('quarterdeck_migrations'))`;

const migrationVersion = (file: string): string => {
  const version = MIGRATION_FILE.exec(file)?.[1];
  if (version === undefined) {
    throw new Error(
      `Migration ${file} must be named NNNN_name.sql in lowercase snake_case`,
    );
  }
  return version;
};

export const loadMigrations = async (
  dir: string = MIGRATIONS_DIR,
): Promise<Migration[]> => {
  const versions = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .map(migrationVersion)
    .toSorted();
  return Promise.all(
    versions.map(async (version) => ({
      version,
      sql: await readFile(join(dir, `${version}.sql`), 'utf8'),
    })),
  );
};

const isApplied = async (tx: Queryable, version: string): Promise<boolean> => {
  const { rows } = await tx.query(
    'select 1 from schema_migrations where version = $1',
    [version],
  );
  return rows.length > 0;
};

const applyMigration = (db: Db, migration: Migration): Promise<boolean> =>
  db.transaction(async (tx) => {
    await tx.exec(LOCK_MIGRATIONS);
    await tx.exec(CREATE_LEDGER);
    if (await isApplied(tx, migration.version)) return false;
    await tx.exec(migration.sql);
    await tx.query('insert into schema_migrations (version) values ($1)', [
      migration.version,
    ]);
    return true;
  });

export const migrate = async (
  db: Db,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> => {
  const migrations = await loadMigrations(dir);
  return migrations.reduce<Promise<string[]>>(async (previous, migration) => {
    const applied = await previous;
    if (await applyMigration(db, migration)) {
      return [...applied, migration.version];
    }
    return applied;
  }, Promise.resolve([]));
};
