import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsSocket } from 'ws';
import { TIMEOUT, startDeck, type Deck } from '../api/harness.js';
import type { PageElement } from './page.js';

const count = (
  all: typeof import('./page.js').all,
  container: PageElement,
  table: string,
): string => {
  const index = all(container, '.qd-table-counts dt').findIndex(
    ({ textContent }) => textContent === table,
  );
  return all(container, '.qd-table-counts dd')[index]?.textContent ?? '';
};

describe('dashboard on a live server', () => {
  const window = new Window();
  let deck: Deck;

  beforeAll(async () => {
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    deck = await startDeck('shell');
  }, TIMEOUT);

  afterAll(async () => {
    await deck.close();
    await window.happyDOM.close();
    vi.unstubAllGlobals();
  }, TIMEOUT);

  it(
    'goes live and follows intents sent through the typed client',
    async () => {
      const { all, render, textOf } = await import('./page.js');
      const { App } = await import('../../src/app.js');
      const { DeckProvider } = await import('../../src/deck/deck.js');
      const { TablesWidget } =
        await import('../../src/widgets/starter/tables.widget.js');
      const served = await deck.serve();
      const stream = {
        url: served.url,
        WebSocket: WsSocket as unknown as typeof WebSocket,
      };
      const { container, unmount } = render(
        <App stream={stream} intents={deck.client} />,
      );
      const tables = render(
        <DeckProvider stream={stream} intents={deck.client}>
          <TablesWidget />
        </DeckProvider>,
      );
      await vi.waitFor(() => {
        expect(textOf(container, '[role="status"]')).toBe('Live');
        expect(count(all, tables.container, 'notebook')).toBe('0');
      });

      await deck.client.notebook.add({ project: deck.project, body: 'hi' });

      await vi.waitFor(() => {
        expect(count(all, tables.container, 'notebook')).toBe('1');
        expect(textOf(container, '.qd-event-list code')).toBe('notebook.add');
      });
      tables.unmount();
      unmount();
    },
    TIMEOUT,
  );
});
