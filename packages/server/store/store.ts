import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { NO_LOCK, lockDataDir, type DataDirLock } from './lock.js';
import { migrate } from './migrate.js';
import { assertProjectSlug, projectDataDir } from './paths.js';

export const STORE_TABLES = [
  'projects',
  'rounds',
  'agents',
  'tickets',
  'cards',
  'turns',
  'events',
  'notebook',
  'charter_proposals',
  'budget',
  'layouts',
] as const;

export type StoreTable = (typeof STORE_TABLES)[number];

export const EVENTS_CHANNEL = 'quarterdeck_events';

export const IN_MEMORY = 'memory://';

export interface StoreOptions {
  project: string;
  home?: string;
  dataDir?: string;
}

export interface Store {
  db: PGlite;
  dataDir: string;
  projectId: string;
  migrated: string[];
  close: () => Promise<void>;
}

const ensureProject = async (db: PGlite, slug: string): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `with inserted as (
       insert into projects (slug, name) values ($1, $1)
       on conflict (slug) do nothing
       returning id
     )
     select id from inserted
     union all
     select id from projects where slug = $1
     limit 1`,
    [slug],
  );
  const [row] = rows;
  if (!row) throw new Error(`Could not register project ${slug}`);
  return row.id;
};

const prepareDataDir = async (
  dataDir: string,
  project: string,
): Promise<DataDirLock> => {
  if (dataDir.startsWith(IN_MEMORY)) return NO_LOCK;
  await mkdir(dataDir, { recursive: true });
  return lockDataDir(`${dataDir}.lock`, project);
};

const startDatabase = async (
  dataDir: string,
  project: string,
  lock: DataDirLock,
): Promise<Store> => {
  const db = await PGlite.create(dataDir);
  try {
    const migrated = await migrate(db);
    const projectId = await ensureProject(db, project);
    const close = async () => {
      try {
        await db.close();
      } finally {
        await lock.release();
      }
    };
    return { db, dataDir, projectId, migrated, close };
  } catch (err) {
    await db.close();
    throw err;
  }
};

export const openStore = async (options: StoreOptions): Promise<Store> => {
  const project = assertProjectSlug(options.project);
  const dataDir = options.dataDir ?? projectDataDir(project, options.home);
  const lock = await prepareDataDir(dataDir, project);
  try {
    return await startDatabase(dataDir, project, lock);
  } catch (err) {
    await lock.release();
    throw err;
  }
};
