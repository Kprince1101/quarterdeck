import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  defaultStreamUrl,
  openStream,
  resumeUrl,
  type StreamConnection,
  type StreamState,
} from '../../src/api/index.js';
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

describe('stream connection', { timeout: TIMEOUT }, () => {
  let deck: Deck;
  const connections: StreamConnection[] = [];

  const connect = (
    url: string,
    Socket: typeof WebSocket = WebSocket,
  ): StreamConnection => {
    const connection = openStream({
      url,
      WebSocket: Socket,
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

    await addNote('after');
    const followed = await waitFor(
      connection,
      (state) => notes(state).length === 2 && state.events.length > 0,
    );
    expect(notes(followed)).toEqual(['after', 'before']);
    expect(kinds(followed).at(-1)).toBe('notebook.add');
    expect(followed.cursor).toBe(followed.events.at(-1)?.id);
  });

  it('reconnects after the server drops and loses no event', async () => {
    const urls: string[] = [];
    class RecordingSocket extends WebSocket {
      constructor(url: string | URL) {
        urls.push(String(url));
        super(url);
      }
    }
    const first = await deck.serve();
    const connection = connect(first.url, RecordingSocket);
    await waitFor(connection, (state) => state.status === 'live');

    await first.close();
    const away = await waitFor(
      connection,
      (state) => state.status === 'reconnecting',
    );
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
