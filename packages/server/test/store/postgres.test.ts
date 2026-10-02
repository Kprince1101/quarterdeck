import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StoreConnectionLostError,
  connectPostgres,
  openStore,
  redactUrl,
  type StoreEvent,
  type TableChange,
} from '../../src/store/index.js';
import {
  POSTGRES_14_URL,
  POSTGRES_URL,
  SHIPPED_MIGRATIONS,
  createDatabase,
  dropDatabase,
} from './backends.js';

const TIMEOUT = 30_000;

const IN_THIS_DATABASE = `database = (
  select oid from pg_database where datname = current_database()
)`;

const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};

describe('redactUrl', () => {
  it('drops the password and keeps the rest', () => {
    expect(redactUrl('postgres://qd:secret@db.local:5433/deck')).toBe(
      'postgres://qd@db.local:5433/deck',
    );
  });

  it('drops password and sslpassword query parameters', () => {
    expect(
      redactUrl(
        'postgres://qd@db.local/deck?sslmode=require&password=secret&sslpassword=key',
      ),
    ).toBe('postgres://qd@db.local/deck?sslmode=require');
  });

  it('names DATABASE_URL instead of echoing a string it cannot parse', () => {
    expect(redactUrl('host=db password=secret')).toBe('DATABASE_URL');
  });
});

describe.runIf(POSTGRES_URL !== '')('openStore on external Postgres', () => {
  let url = '';

  beforeEach(async () => {
    url = await createDatabase(POSTGRES_URL);
  }, TIMEOUT);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await dropDatabase(url, POSTGRES_URL);
  }, TIMEOUT);

  it(
    'uses DATABASE_URL when no data dir is given',
    async () => {
      vi.stubEnv('DATABASE_URL', url);
      const store = await openStore({ project: 'deck' });
      expect(store.backend).toBe('postgres');
      expect(store.location).toBe(redactUrl(url));
      expect(store.migrated).toEqual(SHIPPED_MIGRATIONS);
      await store.close();
    },
    TIMEOUT,
  );

  it(
    'keeps an explicit data dir on PGlite even when DATABASE_URL is set',
    async () => {
      vi.stubEnv('DATABASE_URL', url);
      const store = await openStore({ project: 'deck', dataDir: 'memory://' });
      expect(store.backend).toBe('pglite');
      await store.close();
    },
    TIMEOUT,
  );

  it(
    'persists across restarts and migrates once',
    async () => {
      const first = await openStore({ project: 'deck', databaseUrl: url });
      await first.db.query(
        'insert into notebook (project_id, body) values ($1, $2)',
        [first.projectId, 'remember this'],
      );
      await first.close();

      const second = await openStore({ project: 'deck', databaseUrl: url });
      expect(second.migrated).toEqual([]);
      expect(second.projectId).toBe(first.projectId);
      const { rows } = await second.db.query<{ body: string }>(
        'select body from notebook',
      );
      expect(rows).toEqual([{ body: 'remember this' }]);
      await second.close();
    },
    TIMEOUT,
  );

  it(
    'lets one opener hold a project and rejects the rest until it closes',
    async () => {
      const opens = await Promise.allSettled([
        openStore({ project: 'deck', databaseUrl: url }),
        openStore({ project: 'deck', databaseUrl: url }),
        openStore({ project: 'deck', databaseUrl: url }),
      ]);
      const opened = opens.flatMap((open) => {
        if (open.status === 'fulfilled') return [open.value];
        return [];
      });
      const rejected = opens.flatMap((open) => {
        if (open.status === 'rejected') return [String(open.reason)];
        return [];
      });

      expect(opened).toHaveLength(1);
      expect(rejected).toEqual([
        expect.stringContaining('project deck is already open'),
        expect.stringContaining('project deck is already open'),
      ]);

      await opened[0]?.close();
      const reopened = await openStore({ project: 'deck', databaseUrl: url });
      expect(reopened.migrated).toEqual([]);
      await reopened.close();
    },
    TIMEOUT,
  );

  it(
    'opens different projects side by side and migrates the database once',
    async () => {
      const stores = await Promise.all(
        ['deck', 'hold', 'bridge'].map((project) =>
          openStore({ project, databaseUrl: url }),
        ),
      );

      expect(stores.flatMap((store) => store.migrated).toSorted()).toEqual(
        SHIPPED_MIGRATIONS,
      );
      expect(new Set(stores.map((store) => store.projectId)).size).toBe(3);
      await Promise.all(stores.map((store) => store.close()));
    },
    TIMEOUT,
  );

  it(
    'fails closed when its session dies and frees the project',
    async () => {
      const store = await openStore({ project: 'deck', databaseUrl: url });
      const errors: unknown[] = [];
      const watchErrors: unknown[] = [];
      const changes: TableChange[] = [];
      await store.subscribe(() => undefined, {
        onError: (err) => errors.push(err),
      });
      await store.watch(
        (change) => {
          changes.push(change);
        },
        { onError: (err) => watchErrors.push(err) },
      );

      const admin = await connectPostgres(url);
      const { rows } = await admin.query<{ terminated: boolean }>(
        `select pg_terminate_backend(pid) as terminated from pg_locks
         where locktype = 'advisory' and granted and ${IN_THIS_DATABASE}`,
      );
      await admin.close();
      expect(rows).toEqual([{ terminated: true }]);

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      await vi.waitFor(() => expect(watchErrors).toHaveLength(1));
      expect(errors[0]).toBeInstanceOf(StoreConnectionLostError);
      expect(watchErrors[0]).toBeInstanceOf(StoreConnectionLostError);
      await expect(store.watch(() => undefined)).rejects.toBeInstanceOf(
        StoreConnectionLostError,
      );
      await expect(store.db.query('select 1')).rejects.toBeInstanceOf(
        StoreConnectionLostError,
      );
      await expect(store.publish({ kind: 'late' })).rejects.toBeInstanceOf(
        StoreConnectionLostError,
      );
      await expect(
        store.db.transaction((tx) => tx.query('select 1')),
      ).rejects.toBeInstanceOf(StoreConnectionLostError);
      await expect(
        store.subscribe(() => undefined, { after: 0 }),
      ).rejects.toBeInstanceOf(StoreConnectionLostError);

      const next = await openStore({ project: 'deck', databaseUrl: url });
      expect(next.projectId).toBe(store.projectId);
      await next.db.query(
        `insert into notebook (project_id, body) values ($1, 'after')`,
        [next.projectId],
      );
      await next.close();
      await store.close();
      expect(errors).toHaveLength(1);
      expect(watchErrors).toHaveLength(1);
      expect(changes).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'delivers events in id order when an earlier transaction commits last',
    async () => {
      const store = await openStore({ project: 'deck', databaseUrl: url });
      const seen: StoreEvent[] = [];
      await store.subscribe((event) => {
        seen.push(event);
      });
      const inserted = gate();
      const mayCommit = gate();

      const first = store.db.transaction(async (tx) => {
        await tx.query(
          `insert into events (project_id, kind) values ($1, 'first')`,
          [store.projectId],
        );
        inserted.open();
        await mayCommit.opened;
      });
      await inserted.opened;
      const second = store.publish({ kind: 'second' });
      await vi.waitFor(async () => {
        const { rows } = await store.db.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
           where locktype = 'advisory' and not granted and ${IN_THIS_DATABASE}`,
        );
        expect(rows).toEqual([{ waiting: 1 }]);
      });
      mayCommit.open();
      await Promise.all([first, second]);

      await vi.waitFor(() =>
        expect(seen.map((event) => event.kind)).toEqual(['first', 'second']),
      );
      expect(seen[0]?.id).toBeLessThan(seen[1]?.id ?? 0);
      await store.close();
    },
    TIMEOUT,
  );

  it('says where it could not connect without leaking the password', async () => {
    const unreachable = new URL(url);
    unreachable.port = '1';
    unreachable.password = 'hunter2';
    const error = await openStore({
      project: 'deck',
      databaseUrl: unreachable.toString(),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      `Could not connect to Postgres at ${redactUrl(unreachable.toString())}`,
    );
    expect(String(error)).not.toContain('hunter2');
  });
});

describe.runIf(POSTGRES_14_URL !== '')('openStore on Postgres 14', () => {
  let url = '';

  beforeEach(async () => {
    url = await createDatabase(POSTGRES_14_URL);
  }, TIMEOUT);

  afterEach(async () => {
    await dropDatabase(url, POSTGRES_14_URL);
  }, TIMEOUT);

  it(
    'refuses to open before running any migration',
    async () => {
      await expect(
        openStore({ project: 'deck', databaseUrl: url }),
      ).rejects.toThrow(
        /^Quarterdeck needs Postgres 15 or newer; this server is Postgres 14\./,
      );

      const db = await connectPostgres(url);
      const { rows } = await db.query<{ tables: string[] }>(
        `select coalesce(array_agg(table_name::text), '{}') as tables
         from information_schema.tables where table_schema = 'public'`,
      );
      await db.close();
      expect(rows).toEqual([{ tables: [] }]);
    },
    TIMEOUT,
  );
});
