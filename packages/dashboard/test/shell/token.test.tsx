import { Window } from 'happy-dom';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { WebSocket as WsSocket } from 'ws';
import { TOKEN_STORAGE_KEY } from '../../src/api/index.js';
import { DASHBOARD_LAYOUT } from '../../src/layouts/constants.js';
import { TIMEOUT, startDeck, type Deck } from '../api/harness.js';

const WAIT = { timeout: 5000 };

const DATA_LAYOUT = {
  columns: 12,
  rows: 12,
  items: [
    { id: 'data-1', widget: 'data', x: 0, y: 0, w: 12, h: 12, hidden: false },
  ],
};

describe('dashboard page token', () => {
  let deck: Deck;
  let window: Window;

  const openPage = (url: string): Window => {
    window = new Window({ url });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('location', window.location);
    vi.stubGlobal('history', window.history);
    vi.stubGlobal('sessionStorage', window.sessionStorage);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    return window;
  };

  beforeAll(async () => {
    deck = await startDeck('example');
    await deck.client.layout.save({
      name: DASHBOARD_LAYOUT,
      spec: DATA_LAYOUT,
    });
  }, TIMEOUT);

  afterEach(async () => {
    await window.happyDOM.close();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await deck.close();
  }, TIMEOUT);

  it(
    'takes #token= from the address, drops it, and calls the server with it',
    async () => {
      const page = openPage(
        `${deck.api.url}/board?view=1#token=${deck.api.token}`,
      );
      const { render, textOf } = await import('./page.js');
      const { livePage } = await import('../../src/live.js');
      const served = await deck.serve();
      const options = {
        baseUrl: deck.api.url,
        stream: {
          url: served.url,
          WebSocket: WsSocket as unknown as typeof WebSocket,
        },
      };

      const first = render(livePage(options));
      expect(page.location.href).toBe(`${deck.api.url}/board?view=1`);
      expect(page.location.hash).toBe('');
      expect(page.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(
        deck.api.token,
      );
      await vi.waitFor(() => {
        expect(textOf(first.container, '[role="status"]')).toBe('Live');
        expect(textOf(first.container, '.qd-data-paths code')).toContain(
          `${deck.project}/pg`,
        );
      }, WAIT);
      first.unmount();

      const reloaded = render(livePage(options));
      await vi.waitFor(() => {
        expect(textOf(reloaded.container, '[role="status"]')).toBe('Live');
        expect(textOf(reloaded.container, '.qd-data-paths code')).toContain(
          `${deck.project}/pg`,
        );
      }, WAIT);
      expect(page.location.href).toBe(`${deck.api.url}/board?view=1`);
      reloaded.unmount();
    },
    TIMEOUT,
  );

  it('keeps the rest of the fragment', async () => {
    const page = openPage(`${deck.api.url}/#token=abc&panel=data`);
    const { takePageToken } = await import('../../src/api/index.js');
    expect(takePageToken()).toBe('abc');
    expect(page.location.href).toBe(`${deck.api.url}/#panel=data`);
  });

  it('asks for the printed link when there is no token', async () => {
    openPage(`${deck.api.url}/`);
    const { render, textOf } = await import('./page.js');
    const { livePage } = await import('../../src/live.js');
    const { container, unmount } = render(livePage());
    await vi.waitFor(() => {
      expect(textOf(container, '[role="alert"]')).toContain(
        'Open the link printed by quarterdeck up.',
      );
    }, WAIT);
    expect(container.querySelector('[role="status"]')).toBeNull();
    unmount();
  });

  it('does not take an empty token', async () => {
    const page = openPage(`${deck.api.url}/#token=`);
    const { takePageToken } = await import('../../src/api/index.js');
    expect(takePageToken()).toBeNull();
    expect(page.location.href).toBe(`${deck.api.url}/`);
  });
});
