import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import { createApiToken } from '../../src/api/index.js';
import { setGlobalPause } from '../../src/pause/index.js';
import { IN_MEMORY, openStore } from '../../src/store/index.js';
import type { Store } from '../../src/store/index.js';
import {
  CLOSE_GOING_AWAY,
  CLOSE_READ_ONLY,
  SNAPSHOT_TURNS_PER_AGENT,
  STREAM_HOST,
  STREAM_PATH,
  STREAM_PROTOCOL,
  createStream,
  serveStream,
  streamMessageSchema,
  streamProtocols,
} from '../../src/stream/index.js';
import type {
  ServedStream,
  SnapshotMessage,
  StreamMessage,
} from '../../src/stream/index.js';
import { TEST_BACKENDS, type TestDatabase } from '../store/backends.js';
import { CLEAR_TABLES, seedEveryTable } from './seed.js';

const TIMEOUT = 30_000;
const TAIL = 3;
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const NOTE_BYTES = 2 * 1024 * 1024;

interface Client {
  ws: WebSocket;
  raw: unknown[];
  messages: () => StreamMessage[];
  snapshot: () => SnapshotMessage;
  eventKinds: () => string[];
  closed: Promise<number>;
}

describe.each(TEST_BACKENDS)('websocket stream on $name', (backend) => {
  let database: TestDatabase;
  let store: Store;
  let served: ServedStream;
  let home: string;
  const clients: Client[] = [];

  const connect = (query = '', options?: ClientOptions): Promise<Client> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `${served.url}${query}`,
        streamProtocols(served.token),
        options,
      );
      const raw: unknown[] = [];
      const messages = () =>
        raw.map((message) => streamMessageSchema.parse(message));
      const client: Client = {
        ws,
        raw,
        messages,
        snapshot: () => {
          const [first] = messages();
          if (first?.type !== 'snapshot') throw new Error('no snapshot yet');
          return first;
        },
        eventKinds: () =>
          messages()
            .filter((message) => message.type === 'event')
            .map((message) => message.event.kind),
        closed: new Promise((done) => {
          ws.once('close', (code) => done(code));
        }),
      };
      ws.on('message', (data) => {
        raw.push(JSON.parse(String(data)));
      });
      ws.once('open', () => {
        clients.push(client);
        resolve(client);
      });
      ws.once('error', reject);
    });

  const status = (
    query: string,
    headers: Record<string, string>,
    protocols = streamProtocols(served.token),
  ) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `ws://${STREAM_HOST}:${served.port}${query}`,
        protocols,
        { headers },
      );
      ws.once('unexpected-response', (_, response) => {
        resolve(response.statusCode ?? 0);
        ws.terminate();
      });
      ws.once('open', () => {
        resolve(101);
        ws.terminate();
      });
      ws.on('error', () => undefined);
    });

  const ready = async (client: Client) => {
    await vi.waitFor(() => client.snapshot());
    return client;
  };

  beforeAll(async () => {
    database = await backend.create();
    home = await mkdtemp(join(tmpdir(), 'qd-stream-home-'));
    store = await openStore({ project: 'deck', ...database.storeOptions });
    served = await serveStream({
      store,
      home,
      tail: TAIL,
      allowedOrigins: [DASHBOARD_ORIGIN],
    });
  }, TIMEOUT);

  afterAll(async () => {
    await served.close();
    await store.close();
    await database.drop();
    await rm(home, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      expect(client.messages()).toEqual(client.raw);
      client.ws.terminate();
    }
    await vi.waitFor(() => expect(served.stream.clients).toBe(0));
    await store.db.exec(CLEAR_TABLES);
  });

  it('listens on localhost only', () => {
    expect(served.url).toBe(`ws://127.0.0.1:${served.port}${STREAM_PATH}`);
  });

  it('sends a snapshot of every table first', async () => {
    await seedEveryTable(store);
    const client = await ready(await connect());

    const { tables, cursor } = client.snapshot();
    expect(cursor).toBe(0);
    expect(tables.projects).toEqual([
      expect.objectContaining({ id: store.projectId, slug: 'deck' }),
    ]);
    for (const [table, rows] of Object.entries(tables)) {
      expect(rows, table).toHaveLength(1);
    }
    expect(tables.tickets[0]).toMatchObject({
      title: 'QD6b',
      assigneeId: tables.agents[0]?.id,
    });
    expect(tables.budget[0]).toMatchObject({
      limitTokens: 100_000,
      limitUsd: '12.5000',
    });
    expect(tables.layouts[0]?.spec).toEqual({ widgets: [{ id: 'events' }] });
  });

  it('streams events and table changes after the snapshot', async () => {
    const client = await ready(await connect());

    const event = await store.publish({
      kind: 'ticket.created',
      payload: { title: 'QD6b' },
    });
    const {
      rows: [ticket],
    } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title) values ($1, 'QD6b') returning id`,
      [store.projectId],
    );
    await vi.waitFor(() => expect(client.raw).toHaveLength(3));
    await store.db.query(`update tickets set status = 'done' where id = $1`, [
      ticket?.id,
    ]);
    await vi.waitFor(() => expect(client.raw).toHaveLength(4));
    await store.db.query('delete from tickets where id = $1', [ticket?.id]);

    await vi.waitFor(() => expect(client.raw).toHaveLength(5));
    const [, ...live] = client.messages();
    expect(live).toContainEqual({
      type: 'event',
      event: { ...event, createdAt: event.createdAt.toISOString() },
    });
    const changes = live.filter((message) => message.type === 'change');
    expect(changes.map((change) => [change.table, change.op])).toEqual([
      ['tickets', 'insert'],
      ['tickets', 'update'],
      ['tickets', 'delete'],
    ]);
    expect(changes[0]?.row).toMatchObject({ id: ticket?.id, title: 'QD6b' });
    expect(changes[2]).toMatchObject({ id: ticket?.id, row: null });
  });

  it('sends the machine pause in the snapshot and after each pause.all', async () => {
    const client = await ready(await connect());
    expect(client.snapshot().machine).toEqual({ pausedAt: null });

    await setGlobalPause(home, true);
    await store.publish({ kind: 'pause.all' });
    await store.publish({ kind: 'notebook.add' });
    await vi.waitFor(() => expect(client.eventKinds()).toHaveLength(2));
    const machines = () =>
      client.messages().flatMap((message) => {
        if (message.type !== 'machine') return [];
        return [message.machine.pausedAt];
      });
    expect(machines()).toEqual([expect.any(String)]);
    const [pausedAt] = machines();

    const again = await ready(await connect());
    expect(again.snapshot().machine).toEqual({ pausedAt });

    await setGlobalPause(home, false);
    await store.publish({ kind: 'pause.all' });
    await vi.waitFor(() => expect(machines()).toEqual([pausedAt, null]));
    expect(client.messages().map(({ type }) => type)).toEqual([
      'snapshot',
      'event',
      'machine',
      'event',
      'event',
      'machine',
    ]);
  });

  it('replays only the last few events to a fresh client', async () => {
    for (const kind of ['one', 'two', 'three', 'four', 'five']) {
      await store.publish({ kind });
    }
    const client = await ready(await connect());

    await vi.waitFor(() =>
      expect(client.eventKinds()).toEqual(['three', 'four', 'five']),
    );
    const [first] = client.messages().slice(1);
    expect(first?.type === 'event' && first.event.id).toBe(
      client.snapshot().cursor + 1,
    );
  });

  it('resumes after a cursor without losing events', async () => {
    const first = await ready(await connect());
    const one = await store.publish({ kind: 'one' });
    await vi.waitFor(() => expect(first.eventKinds()).toEqual(['one']));
    first.ws.close();
    await first.closed;

    await store.publish({ kind: 'two' });
    await store.publish({ kind: 'three' });
    const second = await ready(await connect(`?after=${one.id}`));
    expect(second.snapshot().cursor).toBe(one.id);
    await store.publish({ kind: 'four' });

    await vi.waitFor(() =>
      expect(second.eventKinds()).toEqual(['two', 'three', 'four']),
    );
  });

  it('replays the whole log from after=0', async () => {
    for (const kind of ['one', 'two', 'three', 'four']) {
      await store.publish({ kind });
    }
    const client = await ready(await connect('?after=0'));

    await vi.waitFor(() =>
      expect(client.eventKinds()).toEqual(['one', 'two', 'three', 'four']),
    );
  });

  it('closes a client that writes to the read-only stream', async () => {
    const client = await ready(await connect());
    client.ws.send('{"type":"intent"}');

    expect(await client.closed).toBe(CLOSE_READ_ONLY);
  });

  it('refuses bad cursors and unknown paths', async () => {
    const host = `localhost:${served.port}`;
    expect(await status(`${STREAM_PATH}?after=-1`, { host })).toBe(400);
    expect(await status(`${STREAM_PATH}?after=1e3`, { host })).toBe(400);
    expect(await status('/elsewhere', { host })).toBe(404);
  });

  it('accepts only this server as Host, on its own port', async () => {
    const ok = (host: string) => status(STREAM_PATH, { host });
    expect(await ok(`localhost:${served.port}`)).toBe(101);
    expect(await ok(`127.0.0.1:${served.port}`)).toBe(101);
    expect(await ok(`evil.example:${served.port}`)).toBe(403);
    expect(await ok(`localhost:${served.port + 1}`)).toBe(403);
    expect(await ok('localhost')).toBe(403);
  });

  it('accepts its own and configured origins, not other local apps', async () => {
    const host = `localhost:${served.port}`;
    const from = (origin: string) => status(STREAM_PATH, { host, origin });
    expect(await from(`http://localhost:${served.port}`)).toBe(101);
    expect(await from(`http://127.0.0.1:${served.port}`)).toBe(101);
    expect(await from(DASHBOARD_ORIGIN)).toBe(101);
    expect(await from('http://localhost:3000')).toBe(403);
    expect(await from('https://evil.example')).toBe(403);
  });

  it('refuses an upgrade without the token, before any frame', async () => {
    const host = `localhost:${served.port}`;
    expect(await status(STREAM_PATH, { host }, [])).toBe(401);
    expect(await status(STREAM_PATH, { host }, [STREAM_PROTOCOL])).toBe(401);
    expect(
      await status(STREAM_PATH, { host }, streamProtocols(createApiToken())),
    ).toBe(401);
    expect(
      await status(STREAM_PATH, { host }, streamProtocols(`${served.token}x`)),
    ).toBe(401);
    expect(await status(STREAM_PATH, { host })).toBe(101);
  });

  it('answers with the stream protocol, never the token', async () => {
    const client = await ready(await connect());
    expect(client.ws.protocol).toBe(STREAM_PROTOCOL);
  });
});

describe.each(TEST_BACKENDS)(
  'websocket stream with a long history on $name',
  (backend) => {
    let database: TestDatabase;
    let store: Store;

    beforeAll(async () => {
      database = await backend.create();
      store = await openStore({ project: 'deck', ...database.storeOptions });
    }, TIMEOUT);

    afterAll(async () => {
      await store.close();
      await database.drop();
    });

    afterEach(async () => {
      await store.db.exec(CLEAR_TABLES);
    });

    const listen = (served: ServedStream, stallMs = 0) => {
      const ws = new WebSocket(served.url, streamProtocols(served.token));
      const messages: StreamMessage[] = [];
      const closes: number[] = [];
      ws.once('upgrade', (response) => {
        if (stallMs === 0) return;
        response.socket.pause();
        setTimeout(() => response.socket.resume(), stallMs);
      });
      ws.on('message', (data) => {
        messages.push(streamMessageSchema.parse(JSON.parse(String(data))));
      });
      ws.on('close', (code) => closes.push(code));
      const kinds = () =>
        messages
          .filter((message) => message.type === 'event')
          .map((message) => message.event.kind);
      return { ws, messages, closes, kinds };
    };

    it(
      'sends a bounded snapshot and keeps the client past 8 MB of turns',
      async () => {
        const {
          rows: [agent],
        } = await store.db.query<{ id: string }>(
          `insert into agents (project_id, name, role)
         values ($1, 'pangolin', 'builder') returning id`,
          [store.projectId],
        );
        await store.db.query(
          `insert into turns (agent_id, seq, prompt)
         select $1, n, repeat('x', 4096) from generate_series(1, 3000) as n`,
          [agent?.id],
        );
        for (let n = 0; n < 50; n += 1) {
          await store.publish({ kind: `history-${n}` });
        }
        const served = await serveStream({ store });
        const client = listen(served);

        await vi.waitFor(() => expect(client.kinds()).toHaveLength(50), {
          timeout: 10_000,
        });
        await store.publish({ kind: 'live' });
        await vi.waitFor(() => expect(client.kinds().at(-1)).toBe('live'));

        const [snapshot] = client.messages;
        if (snapshot?.type !== 'snapshot') throw new Error('no snapshot');
        expect(snapshot.tables.turns).toHaveLength(SNAPSHOT_TURNS_PER_AGENT);
        expect(snapshot.tables.turns.map((turn) => turn.seq).at(-1)).toBe(3000);
        expect(snapshot.tables.turns[0]).not.toHaveProperty('prompt');
        expect(client.closes).toEqual([]);
        client.ws.terminate();
        await served.close();
      },
      TIMEOUT,
    );

    it(
      'never drops a client for the size of its snapshot',
      async () => {
        await store.db.query(
          `insert into notebook (project_id, body) values ($1, repeat('n', $2))`,
          [store.projectId, NOTE_BYTES],
        );
        for (const kind of ['one', 'two', 'three']) {
          await store.publish({ kind });
        }
        const served = await serveStream({ store, maxBufferedBytes: 1024 });
        const client = listen(served, 300);

        await vi.waitFor(() =>
          expect(client.kinds()).toEqual(['one', 'two', 'three']),
        );
        await store.publish({ kind: 'four' });
        await vi.waitFor(() => expect(client.kinds().at(-1)).toBe('four'));

        const [snapshot] = client.messages;
        expect(
          snapshot?.type === 'snapshot' && snapshot.tables.notebook,
        ).toEqual([expect.objectContaining({ body: 'n'.repeat(NOTE_BYTES) })]);
        expect(client.closes).toEqual([]);
        client.ws.terminate();
        await served.close();
      },
      TIMEOUT,
    );
  },
);

describe('websocket stream upgrades', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const request = (url: string, remoteAddress: string) =>
    ({
      url,
      headers: { host: 'localhost:4317' },
      socket: { remoteAddress, localPort: 4317 },
    }) as unknown as IncomingMessage;

  const socket = () => {
    const written: string[] = [];
    const listening: string[] = [];
    const duplex = {
      end: (chunk: string) => written.push(chunk),
      on: (event: string) => listening.push(event),
    } as unknown as Duplex;
    return { duplex, written, listening };
  };

  it('leaves other paths to the host server', async () => {
    const stream = createStream({ store, token: createApiToken() });
    const { duplex, written } = socket();

    expect(
      stream.handleUpgrade(
        request('/api', '127.0.0.1'),
        duplex,
        Buffer.alloc(0),
      ),
    ).toBe(false);
    expect(written).toEqual([]);
    await stream.close();
  });

  it('refuses connections from other machines', async () => {
    const stream = createStream({ store, token: createApiToken() });
    const { duplex, written, listening } = socket();

    expect(
      stream.handleUpgrade(
        request(STREAM_PATH, '192.168.1.20'),
        duplex,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(written[0]).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(listening).toContain('error');
    await stream.close();
  });

  it(
    'disconnects every client when it closes',
    async () => {
      const served = await serveStream({ store });
      const ws = new WebSocket(served.url, streamProtocols(served.token));
      const closed = new Promise<number>((done) => {
        ws.once('close', (code) => done(code));
      });
      await new Promise((done) => ws.once('message', done));
      expect(served.stream.clients).toBe(1);

      await served.close();

      expect(await closed).toBe(CLOSE_GOING_AWAY);
      expect(served.stream.clients).toBe(0);
    },
    TIMEOUT,
  );
});
