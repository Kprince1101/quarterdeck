import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { EVENT_BATCH, openStore } from '../../src/store/index.js';
import type { StoreEvent, Subscription, Store } from '../../src/store/index.js';
import { TEST_BACKENDS, type TestDatabase } from './backends.js';

const TIMEOUT = 30_000;

const collect = () => {
  const events: StoreEvent[] = [];
  const kinds = () => events.map((event) => event.kind);
  const handler = (event: StoreEvent) => {
    events.push(event);
  };
  return { events, kinds, handler };
};

describe.each(TEST_BACKENDS)('store event bus on $name', (backend) => {
  let database: TestDatabase;
  let store: Store;
  const open: Subscription[] = [];

  const subscribe = async (...args: Parameters<Store['subscribe']>) => {
    const subscription = await store.subscribe(...args);
    open.push(subscription);
    return subscription;
  };

  beforeAll(async () => {
    database = await backend.create();
    store = await openStore({ project: 'deck', ...database.storeOptions });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
    await database.drop();
  });

  afterEach(async () => {
    await Promise.all(
      open.splice(0).map((subscription) => subscription.close()),
    );
    await store.db.exec('delete from events');
  });

  it('publishes an event row and returns it', async () => {
    const event = await store.publish({
      kind: 'ticket.created',
      payload: { title: 'QD2b' },
    });

    expect(event).toEqual({
      id: expect.any(Number),
      projectId: store.projectId,
      agentId: null,
      ticketId: null,
      kind: 'ticket.created',
      payload: { title: 'QD2b' },
      createdAt: expect.any(Date),
    });
  });

  it('delivers only events inserted after subscribing, in order', async () => {
    await store.publish({ kind: 'before' });
    const seen = collect();
    await subscribe(seen.handler);

    const first = await store.publish({ kind: 'one', payload: { n: 1 } });
    await store.db.query(
      `insert into events (project_id, kind) values ($1, 'two')`,
      [store.projectId],
    );
    await store.publish({ kind: 'three' });

    await vi.waitFor(() =>
      expect(seen.kinds()).toEqual(['one', 'two', 'three']),
    );
    expect(seen.events[0]).toEqual(first);
  });

  it('ignores events from other projects in the same database', async () => {
    const {
      rows: [other],
    } = await store.db.query<{ id: string }>(
      `insert into projects (slug, name) values ('other', 'other')
       on conflict (slug) do update set name = excluded.name
       returning id`,
    );
    const seen = collect();
    await subscribe(seen.handler);

    await store.db.query(
      `insert into events (project_id, kind) values ($1, 'theirs')`,
      [other?.id],
    );
    await store.publish({ kind: 'ours' });

    await vi.waitFor(() => expect(seen.kinds()).toEqual(['ours']));
  });

  it('resumes after a cursor, replaying what it missed', async () => {
    const seen = collect();
    const first = await subscribe(seen.handler);
    await store.publish({ kind: 'one' });
    await vi.waitFor(() => expect(seen.kinds()).toEqual(['one']));
    await first.close();

    await store.publish({ kind: 'two' });
    await store.publish({ kind: 'three' });
    const second = await subscribe(seen.handler, { after: first.cursor });
    await store.publish({ kind: 'four' });

    await vi.waitFor(() =>
      expect(seen.kinds()).toEqual(['one', 'two', 'three', 'four']),
    );
    expect(second.cursor).toBe(seen.events.at(-1)?.id);
  });

  it('replays more than one batch in order', async () => {
    const total = EVENT_BATCH * 2 + 5;
    await store.db.query(
      `insert into events (project_id, kind, payload)
       select $1, 'bulk', jsonb_build_object('n', n)
       from generate_series(1, $2::int) as n`,
      [store.projectId, total],
    );
    const seen = collect();
    await subscribe(seen.handler, { after: 0 });

    await vi.waitFor(() => expect(seen.events).toHaveLength(total));
    expect(seen.events.map((event) => event.payload)).toEqual(
      Array.from({ length: total }, (_, index) => ({ n: index + 1 })),
    );
  });

  it('reports a failing handler and keeps delivering', async () => {
    const errors: unknown[] = [];
    const kinds: string[] = [];
    await subscribe(
      (event) => {
        kinds.push(event.kind);
        if (event.kind === 'bad') throw new Error('handler broke');
      },
      { onError: (err) => errors.push(err) },
    );

    await store.publish({ kind: 'bad' });
    await store.publish({ kind: 'good' });

    await vi.waitFor(() => expect(kinds).toEqual(['bad', 'good']));
    expect(errors).toEqual([new Error('handler broke')]);
  });

  it('stops delivering once closed', async () => {
    const seen = collect();
    const subscription = await subscribe(seen.handler);
    await store.publish({ kind: 'one' });
    await vi.waitFor(() => expect(seen.kinds()).toEqual(['one']));

    await subscription.close();
    await subscription.close();
    await store.publish({ kind: 'two' });
    const late = collect();
    await subscribe(late.handler, { after: subscription.cursor });

    await vi.waitFor(() => expect(late.kinds()).toEqual(['two']));
    expect(seen.kinds()).toEqual(['one']);
  });
});

describe('store event bus across restarts', () => {
  let home = '';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'qd-events-'));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(
    'picks up from the last delivered event after the store reopens',
    async () => {
      const seen = collect();
      const first = await openStore({ project: 'deck', home });
      const subscription = await first.subscribe(seen.handler);
      await first.publish({ kind: 'one' });
      await vi.waitFor(() => expect(seen.kinds()).toEqual(['one']));
      const cursor = subscription.cursor;
      await first.close();

      const second = await openStore({ project: 'deck', home });
      await second.publish({ kind: 'two' });
      await second.subscribe(seen.handler, { after: cursor });
      await second.publish({ kind: 'three' });

      await vi.waitFor(() =>
        expect(seen.kinds()).toEqual(['one', 'two', 'three']),
      );
      await second.close();
    },
    TIMEOUT,
  );
});
