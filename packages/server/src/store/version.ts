import type { Queryable } from './db.js';

export const MIN_SERVER_VERSION_NUM = 150_000;

export const assertServerVersion = async (db: Queryable): Promise<void> => {
  const { rows } = await db.query<{ num: number; version: string }>(
    `select current_setting('server_version_num')::int as num,
            current_setting('server_version') as version`,
  );
  const [server] = rows;
  if (server && server.num >= MIN_SERVER_VERSION_NUM) return;
  throw new Error(
    `Quarterdeck needs Postgres 15 or newer; this server is Postgres ${server?.version ?? 'unknown'}`,
  );
};
