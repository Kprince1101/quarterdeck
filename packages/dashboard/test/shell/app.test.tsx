// @vitest-environment happy-dom
import {
  STREAM_TABLES,
  type StreamEvent,
  type StreamMessage,
} from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSE_NORMAL,
  createIntentClient,
  emptyTables,
} from '../../src/api/index.js';
import { App } from '../../src/App.js';
import {
  DeckProvider,
  useDeck,
  type Deck,
} from '../../src/deck/DeckProvider.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import {
  PROJECT_ID,
  STARTER_LAYOUT,
  savedLayout,
  snapshotWith,
} from '../layouts/stream-rows.js';
import { all, render, textOf } from './page.js';

const STREAM_URL = 'ws://127.0.0.1:4317/ws';

const SNAPSHOT: StreamMessage = {
  type: 'snapshot',
  cursor: 0,
  tables: emptyTables(),
  machine: { pausedAt: null },
  layout: null,
};

const event = (id: number, kind: string): StreamMessage => {
  const streamEvent: StreamEvent = {
    id,
    projectId: PROJECT_ID,
    agentId: null,
    ticketId: null,
    kind,
    payload: {},
    createdAt: `2026-10-01T12:00:0${id}.000Z`,
  };
  return { type: 'event', event: streamEvent };
};

const stream = { url: STREAM_URL, WebSocket: FAKE_WEBSOCKET };

const socket = (): FakeSocket => {
  const [only] = FakeSocket.opened;
  if (only === undefined) throw new Error('no socket opened');
  return only;
};

const deliver = (...messages: StreamMessage[]) => {
  act(() => {
    messages.forEach((message) => socket().deliver(message));
  });
};

describe('dashboard shell', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('mounts the header and the widget mount point under one stream', () => {
    const { container, unmount } = render(<App stream={stream} />);
    expect(textOf(container, '.qd-brand')).toBe('Quarterdeck');
    expect(container.querySelector('.qd-mode')).toBeNull();
    expect(container.querySelector('main [data-widget-mount]')).not.toBeNull();
    expect(FakeSocket.opened.map(({ url }) => url)).toEqual([STREAM_URL]);
    unmount();
  });

  it('shows the stream status as it connects, goes live and drops', () => {
    const { container, unmount } = render(<App stream={stream} />);
    const status = () => container.querySelector('[role="status"]');
    expect(status()?.getAttribute('data-status')).toBe('connecting');
    expect(status()?.textContent).toBe('Connecting');

    deliver(SNAPSHOT);
    expect(status()?.getAttribute('data-status')).toBe('live');
    expect(status()?.textContent).toBe('Live');

    act(() => {
      socket().drop(1006);
    });
    expect(status()?.getAttribute('data-status')).toBe('reconnecting');
    expect(status()?.getAttribute('title')).toBe('stream closed (1006)');
    unmount();
  });

  it('gives every panel its own scrolling body', () => {
    const { container, unmount } = render(<App stream={stream} />);
    deliver(snapshotWith(savedLayout(STARTER_LAYOUT)));
    const panels = all(
      container,
      '[data-widget-mount] .qd-grid-cell > .qd-panel',
    );
    expect(panels.length).toBeGreaterThan(1);
    panels.forEach((panel) => {
      expect(all(panel, ':scope > .qd-panel-body')).toHaveLength(1);
      expect(panel.getAttribute('aria-label')).toBeTruthy();
    });
    unmount();
  });

  it('registers the Board widget', () => {
    const { container, unmount } = render(<App stream={stream} />);
    deliver(
      snapshotWith(
        savedLayout({
          columns: 12,
          rows: 12,
          items: [
            {
              id: 'board-1',
              widget: 'board',
              x: 0,
              y: 0,
              w: 12,
              h: 12,
              hidden: false,
            },
          ],
        }),
      ),
    );
    const board = textOf(container, '[aria-label="Board"]');
    expect(board).toContain('deck');
    expect(board).toContain('Pause all');
    unmount();
  });

  it('registers the Driver widget', () => {
    const { container, unmount } = render(<App stream={stream} />);
    deliver(
      snapshotWith(
        savedLayout({
          columns: 12,
          rows: 12,
          items: [
            {
              id: 'driver-1',
              widget: 'driver',
              x: 0,
              y: 0,
              w: 12,
              h: 12,
              hidden: false,
            },
          ],
        }),
      ),
    );
    expect(textOf(container, '[aria-label="Driver"]')).toContain(
      'No voyages yet.',
    );
    unmount();
  });

  it('wires the starter panels to the stream', () => {
    const { container, unmount } = render(<App stream={stream} />);
    expect(textOf(container, '[aria-label="Events"]')).toContain(
      'No events yet.',
    );

    deliver(
      snapshotWith(savedLayout(STARTER_LAYOUT)),
      event(1, 'project.created'),
      event(2, 'notebook.added'),
    );
    const tables = all(container, '.qd-table-counts dt').map(
      ({ textContent }) => textContent,
    );
    expect(tables).toEqual(STREAM_TABLES);
    const kinds = all(container, '.qd-event-list code').map(
      ({ textContent }) => textContent,
    );
    expect(kinds).toEqual(['notebook.added', 'project.created']);
    unmount();
  });

  it('closes the socket when the dashboard unmounts', () => {
    const { unmount } = render(<App stream={stream} />);
    unmount();
    expect(socket().closedWith).toBe(CLOSE_NORMAL);
  });
});

describe('useDeck', () => {
  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('hands widgets the stream and the intent client', () => {
    const intents = createIntentClient({ baseUrl: 'http://127.0.0.1:1' });
    let deck: Deck | undefined;
    const Probe = () => {
      deck = useDeck();
      return null;
    };
    const { unmount } = render(
      <DeckProvider stream={stream} intents={intents}>
        <Probe />
        <Probe />
      </DeckProvider>,
    );
    expect(deck?.intents).toBe(intents);
    expect(deck?.stream.status).toBe('connecting');
    expect(FakeSocket.opened).toHaveLength(1);
    unmount();
  });

  it('refuses to run outside a DeckProvider', () => {
    const Probe = () => {
      useDeck();
      return null;
    };
    expect(() => render(<Probe />)).toThrow('useDeck needs a <DeckProvider>');
  });
});
