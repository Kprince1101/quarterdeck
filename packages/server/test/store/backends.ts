import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  IN_MEMORY,
  connectPostgres,
  type Db,
  type StoreBackend,
  type StoreOptions,
  type Unlisten,
} from '../../src/store/index.js';

export interface TestDatabase {
  storeOptions: Pick<StoreOptions, 'dataDir' | 'databaseUrl'>;
  url: string;
  connect: () => Promise<Db>;
  drop: () => Promise<void>;
}

export interface TestBackend {
  name: StoreBackend;
  create: () => Promise<TestDatabase>;
}

export const SHIPPED_MIGRATIONS = [
  '0001_init',
  '0002_agent_names',
  '0003_intents',
  '0004_table_changes',
  '0005_event_order',
  '0006_card_context',
  '0008_ticket_proposals',
  '0012_turns_ended_at',
  '0015_project_pause',
  '0018_notebook_proposals',
  '0022_agent_pids',
  '0023_intent_order',
  '0024_voyages',
  '0025_project_services',
  '0026_global_voyage',
  '0027_card_sign_in',
  '0028_card_attachments',
];

export const POSTGRES_URL = process.env['QUARTERDECK_TEST_DATABASE_URL'] ?? '';

export const POSTGRES_14_URL = process.env['QUARTERDECK_TEST_PG14_URL'] ?? '';

const withAdmin = async (
  adminUrl: string,
  sql: (client: pg.Client) => string,
): Promise<void> => {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql(client));
  } finally {
    await client.end();
  }
};

export const createDatabase = async (adminUrl: string): Promise<string> => {
  const name = `qd_test_${randomUUID().replaceAll('-', '')}`;
  await withAdmin(
    adminUrl,
    (client) => `create database ${client.escapeIdentifier(name)}`,
  );
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

export const dropDatabase = (url: string, adminUrl: string): Promise<void> =>
  withAdmin(
    adminUrl,
    (client) =>
      `drop database if exists ${client.escapeIdentifier(new URL(url).pathname.slice(1))} with (force)`,
  );

const pglite: TestBackend = {
  name: 'pglite',
  create: () =>
    Promise.resolve({
      storeOptions: { dataDir: IN_MEMORY },
      url: IN_MEMORY,
      connect: () => PGlite.create(),
      drop: () => Promise.resolve(),
    }),
};

const postgres: TestBackend = {
  name: 'postgres',
  create: async () => {
    const url = await createDatabase(POSTGRES_URL);
    return {
      storeOptions: { databaseUrl: url },
      url,
      connect: () => connectPostgres(url),
      drop: () => dropDatabase(url, POSTGRES_URL),
    };
  },
};

export const TEST_BACKENDS: TestBackend[] = [pglite];
if (POSTGRES_URL !== '') TEST_BACKENDS.push(postgres);

export interface NextPayload {
  payload: Promise<string>;
  unlisten: Unlisten;
}

export const nextPayload = async (
  db: Db,
  channel: string,
): Promise<NextPayload> => {
  let onPayload: (payload: string) => void = () => undefined;
  const payload = new Promise<string>((resolve) => {
    onPayload = resolve;
  });
  const unlisten = await db.listen(channel, (received) => {
    onPayload(received);
  });
  return { payload, unlisten };
};
