import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
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
    `insert into projects (slug, name) values ($1, $1)
     on conflict (slug) do update set slug = excluded.slug
     returning id`,
    [slug],
  );
  const [row] = rows;
  if (!row) throw new Error(`Could not register project ${slug}`);
  return row.id;
};

const prepareDataDir = async (dataDir: string): Promise<void> => {
  if (dataDir.startsWith(IN_MEMORY)) return;
  await mkdir(dataDir, { recursive: true });
};

export const openStore = async (options: StoreOptions): Promise<Store> => {
  const project = assertProjectSlug(options.project);
  const dataDir = options.dataDir ?? projectDataDir(project, options.home);
  await prepareDataDir(dataDir);
  const db = await PGlite.create(dataDir);
  try {
    const migrated = await migrate(db);
    const projectId = await ensureProject(db, project);
    return { db, dataDir, projectId, migrated, close: () => db.close() };
  } catch (err) {
    await db.close();
    throw err;
  }
};
