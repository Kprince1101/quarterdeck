import {
  streamProtocols,
  type StreamMessage,
} from '@quarterdeck/server/stream-schema';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { WebSocket as WsSocket } from 'ws';
import {
  defaultStreamUrl,
  emptyTables,
  openStream,
  resumeUrl,
  type StreamConnection,
  type StreamState,
} from '../../src/api/index.js';
import { FAKE_WEBSOCKET, FakeSocket } from './fake-socket.js';
import { TIMEOUT, startDeck, waitFor, type Deck } from './harness.js';

const notes = (state: StreamState): string[] =>
  state.tables.notebook.map(({ body }) => body).toSorted();

const kinds = (state: StreamState): string[] =>
  state.events.map(({ kind }) => kind);

const isIntent = (payload: unknown, intentId: string | null): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as { intentId?: unknown }).intentId === intentId;

describe('stream urls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to /ws on the page host', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:4317' });
    expect(defaultStreamUrl()).toBe('ws://localhost:4317/ws');
    vi.stubGlobal('location', { protocol: 'https:', host: 'deck.test' });
    expect(defaultStreamUrl()).toBe('wss://deck.test/ws');
  });

  it('needs a url off the page', () => {
    expect(() => defaultStreamUrl()).toThrow('pass the stream url');
  });

  it('resumes after the cursor once it has one', () => {
    const url = 'ws://127.0.0.1:4317/ws';
    expect(resumeUrl(url, null)).toBe(url);
    expect(resumeUrl(url, 0)).toBe(`${url}?after=0`);
    expect(resumeUrl(url, 42)).toBe(`${url}?after=42`);
  });
});

describe('stream retries', () => {
  const STREAM_URL = 'ws://127.0.0.1:4317/ws';
  const SNAPSHOT: StreamMessage = {
    type: 'snapshot',
    cursor: 9,
    tables: emptyTables(),
    machine: { pausedAt: null },
    layout: null,
  };

  const open = (onError?: (err: unknown) => void) =>
    openStream({
      url: STREAM_URL,
      WebSocket: FAKE_WEBSOCKET,
      retryDelayMs: 100,
      maxRetryDelayMs: 300,
      onError,
    });

  const latest = (): FakeSocket => {
    const socket = FakeSocket.opened.at(-1);
    if (!socket) throw new Error('no socket opened');
    return socket;
  };

  const expectRetryAfter = (delay: number): void => {
    const before = FakeSocket.opened.length;
    vi.advanceTimersByTime(delay - 1);
    expect(FakeSocket.opened).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.opened).toHaveLength(before + 1);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.opened = [];
  });

  it('retries a failed socket on a doubling, capped delay', () => {
    const connection = open();
    [100, 200, 300, 300].forEach((delay) => {
      latest().fail();
      expect(connection.state).toMatchObject({
        status: 'reconnecting',
        error: 'stream failed',
      });
      expectRetryAfter(delay);
    });
    connection.close();
  });

  it('resumes from its cursor and resets the delay after a snapshot', () => {
    const connection = open();
    latest().fail();
    expectRetryAfter(100);
    latest().deliver(SNAPSHOT);
    latest().drop(1006);
    expect(connection.state).toMatchObject({
      status: 'reconnecting',
      cursor: 9,
      error: 'stream closed (1006)',
    });
    expectRetryAfter(100);
    expect(latest().url).toBe(`${STREAM_URL}?after=9`);
    connection.close();
  });

  it('ignores a socket it has moved on from', () => {
    const connection = open();
    const old = latest();
    old.fail();
    old.drop(1006);
    expectRetryAfter(100);
    old.deliver(SNAPSHOT);
    old.drop(1006);
    expect(connection.state).toMatchObject({
      status: 'reconnecting',
      cursor: null,
    });
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.opened).toHaveLength(2);
    connection.close();
  });

  it('reports a message it cannot read and keeps going', () => {
    const onError = vi.fn();
    const connection = open(onError);
    latest().deliverRaw('{"type":"snapshot"}');
    expect(onError).toHaveBeenCalledOnce();
    expect(connection.state).toMatchObject({
      status: 'connecting',
      cursor: null,
    });
    expect(connection.state.error).toContain('cursor');
    latest().deliver(SNAPSHOT);
    expect(connection.state).toMatchObject({ status: 'live', error: null });
    connection.close();
  });

  it('stops retrying once closed', () => {
    const connection = open();
    latest().fail();
    connection.close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(connection.state.status).toBe('closed');
  });
});

describe('stream connection', { timeout: TIMEOUT }, () => {
  let deck: Deck;
  const connections: StreamConnection[] = [];

  const connect = (
    url: string,
    Socket: new (url: string, protocols?: string[]) => WsSocket = WsSocket,
    token: string | null = deck.api.token,
  ): StreamConnection => {
    const connection = openStream({
      url,
      token: token ?? undefined,
      WebSocket: Socket as unknown as typeof WebSocket,
      retryDelayMs: 10,
      maxRetryDelayMs: 50,
    });
    connections.push(connection);
    return connection;
  };

  const addNote = (body: string) =>
    deck.client.notebook.add({ project: deck.project, body });

  beforeAll(async () => {
    deck = await startDeck('stream');
    await addNote('before');
  }, TIMEOUT);

  afterEach(() => {
    connections.splice(0).forEach((connection) => connection.close());
  });

  afterAll(async () => {
    await deck.close();
  });

  it('starts from the snapshot, then follows events and changes', async () => {
    const served = await deck.serve();
    const connection = connect(served.url);
    expect(connection.state.status).toBe('connecting');

    const live = await waitFor(connection, (state) => state.status === 'live');
    expect(notes(live)).toEqual(['before']);
    expect(live.tables.projects.map(({ slug }) => slug)).toEqual(['stream']);
    const replayed = await waitFor(connection, (state) =>
      kinds(state).includes('notebook.add'),
    );
    expect(kinds(replayed)).toEqual(['project.create', 'notebook.add']);

    const added = await addNote('after');
    const followed = await waitFor(
      connection,
      (state) =>
        notes(state).length === 2 &&
        state.events.some(({ payload }) => isIntent(payload, added.id)),
    );
    expect(notes(followed)).toEqual(['after', 'before']);
    expect(kinds(followed)).toEqual([
      'project.create',
      'notebook.add',
      'notebook.add',
    ]);
    expect(followed.cursor).toBe(followed.events.at(-1)?.id);
  });

  it('reconnects after the server drops and loses no event', async () => {
    const urls: string[] = [];
    class RecordingSocket extends WsSocket {
      constructor(url: string | URL, protocols?: string[]) {
        urls.push(String(url));
        super(url, protocols);
      }
    }
    const first = await deck.serve();
    const connection = connect(first.url, RecordingSocket);
    await waitFor(connection, (state) => state.status === 'live');

    const dropped = waitFor(
      connection,
      (state) => state.status === 'reconnecting',
    );
    await first.close();
    const away = await dropped;
    expect(away.error).toBe('stream closed (1001)');
    const missed = await addNote('while away');

    await deck.serve(first.port);
    const back = await waitFor(connection, (state) =>
      state.events.some(({ payload }) => isIntent(payload, missed.id)),
    );
    expect(back.status).toBe('live');
    expect(back.error).toBeNull();
    expect(notes(back)).toContain('while away');
    expect(urls[0]).toBe(first.url);
    expect(urls.slice(1)).toContain(`${first.url}?after=${away.cursor}`);
    const ids = back.events.map(({ id }) => id);
    expect(ids).toEqual(ids.toSorted((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['no', null, undefined],
    ['a wrong', 'not-the-token', streamProtocols('not-the-token')],
  ])(
    'never goes live with %s token, and keeps the token out of the url',
    async (_, token, protocols) => {
      const urls: string[] = [];
      const offered: (string[] | undefined)[] = [];
      class RecordingSocket extends WsSocket {
        constructor(url: string | URL, protocols?: string[]) {
          urls.push(String(url));
          offered.push(protocols);
          super(url, protocols);
        }
      }
      const served = await deck.serve();
      const connection = connect(served.url, RecordingSocket, token);
      await vi.waitFor(() => expect(urls.length).toBeGreaterThan(2));
      expect(connection.state.status).toBe('reconnecting');
      expect(connection.state.cursor).toBeNull();
      expect(served.stream.clients).toBe(0);
      expect(new Set(urls)).toEqual(new Set([served.url]));
      expect(offered[0]).toEqual(protocols);
    },
  );

  it('offers the token as a protocol, not in the url', async () => {
    const urls: string[] = [];
    class RecordingSocket extends WsSocket {
      constructor(url: string | URL, protocols?: string[]) {
        urls.push(String(url));
        super(url, protocols);
      }
    }
    const served = await deck.serve();
    const connection = connect(served.url, RecordingSocket);
    await waitFor(connection, (state) => state.status === 'live');
    expect(urls).toEqual([served.url]);
    expect(urls[0]).not.toContain(deck.api.token);
  });

  it('stops for good once closed', async () => {
    const served = await deck.serve();
    const connection = connect(served.url);
    await waitFor(connection, (state) => state.status === 'live');
    const listener = vi.fn();
    connection.subscribe(listener);

    connection.close();
    expect(connection.state.status).toBe('closed');
    await addNote('unseen');
    await vi.waitFor(() => expect(served.stream.clients).toBe(0));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(notes(connection.state)).not.toContain('unseen');
  });
});
