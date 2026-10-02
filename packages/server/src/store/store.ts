import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  watchChanges,
  type ChangeHandler,
  type WatchOptions,
  type Watcher,
} from './changes.js';
import {
  publishEvent,
  subscribeEvents,
  type EventHandler,
  type PublishInput,
  type StoreEvent,
  type SubscribeOptions,
  type Subscription,
} from './events.js';
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
  'intents',
] as const;

export type StoreTable = (typeof STORE_TABLES)[number];

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
  publish: (input: PublishInput) => Promise<StoreEvent>;
  subscribe: (
    handler: EventHandler,
    options?: SubscribeOptions,
  ) => Promise<Subscription>;
  watch: (handler: ChangeHandler, options?: WatchOptions) => Promise<Watcher>;
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
    const subscriptions = new Set<() => Promise<void>>();
    const track = (close: () => Promise<void>): (() => Promise<void>) => {
      const release = (): Promise<void> => {
        subscriptions.delete(release);
        return close();
      };
      subscriptions.add(release);
      return release;
    };
    const publish = (input: PublishInput) => publishEvent(db, projectId, input);
    const subscribe = async (
      handler: EventHandler,
      options?: SubscribeOptions,
    ): Promise<Subscription> => {
      const subscription = await subscribeEvents(
        db,
        projectId,
        handler,
        options,
      );
      const release = track(() => subscription.close());
      return {
        get cursor() {
          return subscription.cursor;
        },
        close: release,
      };
    };
    const watch = async (
      handler: ChangeHandler,
      options?: WatchOptions,
    ): Promise<Watcher> => {
      const watcher = await watchChanges(db, projectId, handler, options);
      return { close: track(() => watcher.close()) };
    };
    const close = async () => {
      try {
        await Promise.allSettled(
          [...subscriptions].map((release) => release()),
        );
        await db.close();
      } finally {
        await lock.release();
      }
    };
    return {
      db,
      dataDir,
      projectId,
      migrated,
      publish,
      subscribe,
      watch,
      close,
    };
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
