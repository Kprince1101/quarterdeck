import pg from 'pg';
import type { Db, Queryable, Unlisten } from './db.js';
import { ProjectOpenError, StoreConnectionLostError } from './errors.js';

type PayloadHandler = (payload: string) => void;

export type LostHandler = (err: StoreConnectionLostError) => void;

interface Channel {
  handlers: Set<PayloadHandler>;
  ready: Promise<unknown>;
}

interface Fence {
  readonly lost: StoreConnectionLostError | undefined;
  guard: <T>(run: () => Promise<T>) => Promise<T>;
  trip: (cause?: unknown) => void;
  close: () => void;
  onLost: (handler: LostHandler) => void;
}

export interface PostgresConnection {
  db: Db;
  onLost: (handler: LostHandler) => void;
}

interface Connection extends PostgresConnection {
  session: pg.Client;
}

const APPLICATION_NAME = 'quarterdeck';

const SECRET_PARAMS = ['password', 'sslpassword'];

const MIN_SAFE_INT8 = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INT8 = BigInt(Number.MAX_SAFE_INTEGER);

const parseInt8 = (value: string): number | bigint => {
  const parsed = BigInt(value);
  if (parsed < MIN_SAFE_INT8 || parsed > MAX_SAFE_INT8) return parsed;
  return Number(parsed);
};

const pgliteTypes = (): pg.TypeOverrides => {
  const types = new pg.TypeOverrides();
  types.setTypeParser(pg.types.builtins.INT8, parseInt8);
  return types;
};

const reportError = (err: unknown): void => {
  console.error('quarterdeck postgres connection failed', err);
};

export const redactUrl = (url: string): string => {
  if (!URL.canParse(url)) return 'DATABASE_URL';
  const parsed = new URL(url);
  parsed.password = '';
  SECRET_PARAMS.forEach((param) => parsed.searchParams.delete(param));
  return parsed.toString();
};

const createFence = (location: string): Fence => {
  let lost: StoreConnectionLostError | undefined;
  let closing = false;
  const handlers = new Set<LostHandler>();
  const notifyLost = (handler: LostHandler, err: StoreConnectionLostError) => {
    try {
      handler(err);
    } catch (failure) {
      reportError(failure);
    }
  };
  return {
    get lost() {
      return lost;
    },
    guard: (run) => {
      if (lost) return Promise.reject(lost);
      return run();
    },
    trip: (cause) => {
      if (lost || closing) return;
      const err = new StoreConnectionLostError(location, { cause });
      lost = err;
      handlers.forEach((handler) => notifyLost(handler, err));
    },
    close: () => {
      closing = true;
    },
    onLost: (handler) => {
      handlers.add(handler);
      if (lost) notifyLost(handler, lost);
    },
  };
};

const queryable = (
  client: pg.Pool | pg.PoolClient,
  fence: Fence,
): Queryable => ({
  query: <T>(sql: string, params: unknown[] = []) =>
    fence.guard(async () => {
      const { rows } = await client.query(sql, params);
      return { rows: rows as T[] };
    }),
  exec: (sql: string) => fence.guard(() => client.query(sql)),
});

const rollback = async (client: pg.PoolClient): Promise<boolean> => {
  try {
    await client.query('rollback');
    return false;
  } catch {
    return true;
  }
};

const inTransaction = async <T>(
  pool: pg.Pool,
  fence: Fence,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> => {
  const client = await fence.guard(() => pool.connect());
  let broken = false;
  try {
    await client.query('begin');
    const result = await fn(queryable(client, fence));
    await fence.guard(() => client.query('commit'));
    return result;
  } catch (err) {
    broken = await rollback(client);
    throw err;
  } finally {
    client.release(broken);
  }
};

const notify = (handlers: Set<PayloadHandler>, payload: string): void => {
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      reportError(err);
    }
  }
};

const createListen = (session: pg.Client, fence: Fence): Db['listen'] => {
  const channels = new Map<string, Channel>();
  session.on('notification', ({ channel, payload }) => {
    const entry = channels.get(channel);
    if (entry) notify(entry.handlers, payload ?? '');
  });

  const join = (channel: string): Channel => {
    const existing = channels.get(channel);
    if (existing) return existing;
    const ready = session.query(`listen ${session.escapeIdentifier(channel)}`);
    const entry = { handlers: new Set<PayloadHandler>(), ready };
    channels.set(channel, entry);
    return entry;
  };

  const leave = async (channel: string, entry: Channel): Promise<void> => {
    if (entry.handlers.size > 0 || channels.get(channel) !== entry) return;
    channels.delete(channel);
    if (fence.lost) return;
    await session.query(`unlisten ${session.escapeIdentifier(channel)}`);
  };

  const listen = async (
    channel: string,
    onPayload: PayloadHandler,
  ): Promise<Unlisten> => {
    const entry = join(channel);
    const handler: PayloadHandler = (payload) => onPayload(payload);
    entry.handlers.add(handler);
    const unlisten = async () => {
      entry.handlers.delete(handler);
      await leave(channel, entry);
    };
    try {
      await entry.ready;
    } catch (err) {
      entry.handlers.delete(handler);
      if (channels.get(channel) === entry) channels.delete(channel);
      throw err;
    }
    return unlisten;
  };

  return (channel, onPayload) => fence.guard(() => listen(channel, onPayload));
};

const connectSession = async (
  config: pg.ClientConfig,
  url: string,
  fence: Fence,
): Promise<pg.Client> => {
  const session = new pg.Client(config);
  session.on('error', (err) => {
    reportError(err);
    fence.trip(err);
  });
  session.on('end', () => fence.trip());
  try {
    await session.connect();
    return session;
  } catch (err) {
    throw new Error(`Could not connect to Postgres at ${redactUrl(url)}`, {
      cause: err,
    });
  }
};

const clientConfig = (url: string): pg.ClientConfig => ({
  connectionString: url,
  application_name: APPLICATION_NAME,
  keepAlive: true,
  types: pgliteTypes(),
});

const createPool = (config: pg.ClientConfig): pg.Pool => {
  const pool = new pg.Pool(config);
  pool.on('error', reportError);
  return pool;
};

export interface PostgresPool extends Queryable {
  close(): Promise<void>;
}

export const createPostgresPool = (url: string): PostgresPool => {
  const pool = createPool(clientConfig(url));
  return {
    ...queryable(pool, createFence(redactUrl(url))),
    close: () => pool.end(),
  };
};

const connect = async (url: string): Promise<Connection> => {
  const config = clientConfig(url);
  const fence = createFence(redactUrl(url));
  const session = await connectSession(config, url, fence);
  const pool = createPool(config);
  const db: Db = {
    ...queryable(pool, fence),
    transaction: (fn) => inTransaction(pool, fence, fn),
    listen: createListen(session, fence),
    close: async () => {
      fence.close();
      await Promise.all([pool.end(), session.end()]);
    },
  };
  return { db, session, onLost: fence.onLost };
};

const lockProject = async (
  session: pg.Client,
  project: string,
): Promise<void> => {
  const { rows } = await session.query<{ locked: boolean }>(
    `select pg_try_advisory_lock(hashtext('quarterdeck_project'), hashtext($1)) as locked`,
    [project],
  );
  if (rows[0]?.locked) return;
  throw new ProjectOpenError(project);
};

export const connectPostgres = async (url: string): Promise<Db> =>
  (await connect(url)).db;

export interface PostgresSession extends Pick<Queryable, 'query'> {
  close(): Promise<void>;
}

export class PostgresSessionError extends Error {
  constructor(cause: unknown) {
    super('Could not connect to Postgres', { cause });
    this.name = 'PostgresSessionError';
  }
}

export const connectPostgresSession = async (
  url: string,
  applicationName: string,
): Promise<PostgresSession> => {
  const client = new pg.Client({
    connectionString: url,
    application_name: applicationName,
    types: pgliteTypes(),
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw new PostgresSessionError(err);
  }
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const { rows } = await client.query(sql, params);
      return { rows: rows as T[] };
    },
    close: () => client.end(),
  };
};

export const openPostgres = async (
  url: string,
  project: string,
): Promise<PostgresConnection> => {
  const { db, session, onLost } = await connect(url);
  try {
    await lockProject(session, project);
    return { db, onLost };
  } catch (err) {
    await db.close();
    throw err;
  }
};
