import { PGlite } from '@electric-sql/pglite';
import { ensurePrivateDir } from '../lib/private-fs.js';
import type { Db, LiveFeed } from './db.js';
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
import {
  assertProjectSlug,
  dataDirLockPath,
  projectDataDir,
  projectDir,
  quarterdeckHome,
} from './paths.js';
import { openPostgres, redactUrl, type LostHandler } from './postgres.js';
import { assertServerVersion } from './version.js';

export const STORE_TABLES = [
  'projects',
  'rounds',
  'agents',
  'tickets',
  'cards',
  'turns',
  'events',
  'notebook',
  'notebook_proposals',
  'charter_proposals',
  'budget',
  'layouts',
  'intents',
] as const;

export type StoreTable = (typeof STORE_TABLES)[number];

export type StoreBackend = 'pglite' | 'postgres';

export const IN_MEMORY = 'memory://';

export interface StoreOptions {
  project: string;
  home?: string;
  dataDir?: string;
  databaseUrl?: string | undefined;
}

export interface Store {
  db: Db;
  backend: StoreBackend;
  location: string;
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

interface Connection {
  db: Db;
  backend: StoreBackend;
  location: string;
  release: () => Promise<void>;
  onLost: (handler: LostHandler) => void;
}

const NEVER_LOST = (): void => undefined;

const ensureProject = async (db: Db, slug: string): Promise<string> => {
  await db.query(
    `insert into projects (slug, name) values ($1, $1)
     on conflict (slug) do nothing`,
    [slug],
  );
  const { rows } = await db.query<{ id: string }>(
    'select id from projects where slug = $1',
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
  await ensurePrivateDir(dataDir);
  return lockDataDir(dataDirLockPath(dataDir), project);
};

const openPglite = async (
  dataDir: string,
  project: string,
): Promise<Connection> => {
  const lock = await prepareDataDir(dataDir, project);
  try {
    const db = await PGlite.create(dataDir);
    return {
      db,
      backend: 'pglite',
      location: dataDir,
      release: lock.release,
      onLost: NEVER_LOST,
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
};

const openHomePglite = async (
  home: string,
  project: string,
): Promise<Connection> => {
  await ensurePrivateDir(home);
  await ensurePrivateDir(projectDir(project, home));
  return openPglite(projectDataDir(project, home), project);
};

const openExternal = async (
  url: string,
  project: string,
): Promise<Connection> => ({
  ...(await openPostgres(url, project)),
  backend: 'postgres',
  location: redactUrl(url),
  release: NO_LOCK.release,
});

export const configuredDatabaseUrl = (
  databaseUrl?: string,
): string | undefined => {
  const url = databaseUrl ?? process.env['DATABASE_URL'];
  if (url === '') return undefined;
  return url;
};

const connect = (
  options: StoreOptions,
  project: string,
): Promise<Connection> => {
  const url = configuredDatabaseUrl(options.databaseUrl);
  if (options.dataDir === undefined && url !== undefined) {
    return openExternal(url, project);
  }
  if (options.dataDir !== undefined)
    return openPglite(options.dataDir, project);
  return openHomePglite(options.home ?? quarterdeckHome(), project);
};

const disconnect = async ({ db, release }: Connection): Promise<void> => {
  try {
    await db.close();
  } finally {
    await release();
  }
};

const startStore = async (
  connection: Connection,
  project: string,
): Promise<Store> => {
  const { db, backend, location } = connection;
  await assertServerVersion(db);
  const migrated = await migrate(db);
  const projectId = await ensureProject(db, project);
  const feeds = new Set<LiveFeed>();
  const track = (feed: LiveFeed): (() => Promise<void>) => {
    feeds.add(feed);
    return () => {
      feeds.delete(feed);
      return feed.close();
    };
  };
  const publish = (input: PublishInput) => publishEvent(db, projectId, input);
  const subscribe = async (
    handler: EventHandler,
    options?: SubscribeOptions,
  ): Promise<Subscription> => {
    const subscription = await subscribeEvents(db, projectId, handler, options);
    const close = track(subscription);
    return {
      get cursor() {
        return subscription.cursor;
      },
      close,
    };
  };
  const watch = async (
    handler: ChangeHandler,
    options?: WatchOptions,
  ): Promise<Watcher> => {
    const watcher = await watchChanges(db, projectId, handler, options);
    return { close: track(watcher) };
  };
  const settle = async (
    end: (feed: LiveFeed) => Promise<void>,
  ): Promise<void> => {
    const open = [...feeds];
    feeds.clear();
    await Promise.allSettled(open.map(end));
  };
  connection.onLost((err) => {
    settle((feed) => feed.fail(err)).catch(() => undefined);
  });
  const close = async () => {
    await settle((feed) => feed.close());
    await disconnect(connection);
  };
  return {
    db,
    backend,
    location,
    projectId,
    migrated,
    publish,
    subscribe,
    watch,
    close,
  };
};

export const openStore = async (options: StoreOptions): Promise<Store> => {
  const project = assertProjectSlug(options.project);
  const connection = await connect(options, project);
  try {
    return await startStore(connection, project);
  } catch (err) {
    await disconnect(connection);
    throw err;
  }
};
