import { isGloballyPaused } from '@quarterdeck/server';
import { Window, type HTMLElement as HappyElement } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsSocket } from 'ws';
import { TIMEOUT, startDeck, type Deck } from '../api/harness.js';
import type { PageElement } from './page.js';

const clickable = (element: PageElement | undefined): HappyElement => {
  if (element === undefined) throw new Error('nothing to press');
  return element as unknown as HappyElement;
};

const press = (container: PageElement, label: string): void => {
  clickable(
    container.querySelector(`[aria-label="${label}"]`) ?? undefined,
  ).click();
};

const pressNamed = (container: PageElement, name: string): void => {
  clickable(
    Array.from(container.querySelectorAll('button')).find(
      ({ textContent }) => textContent === name,
    ),
  ).click();
};

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
      const served = await deck.serve();
      const { container, unmount } = render(
        <App
          stream={{
            url: served.url,
            WebSocket: WsSocket as unknown as typeof WebSocket,
          }}
          intents={deck.client}
        />,
      );
      await vi.waitFor(() => {
        expect(textOf(container, '[role="status"]')).toBe('Live');
      });
      press(container, 'Hide Board');
      press(container, 'Show Tables');
      await vi.waitFor(() => {
        expect(count(all, container, 'notebook')).toBe('0');
      });

      await deck.client.notebook.add({ project: deck.project, body: 'hi' });

      await vi.waitFor(() => {
        expect(count(all, container, 'notebook')).toBe('1');
        expect(textOf(container, '.qd-event-list code')).toBe('notebook.add');
      });
      unmount();
    },
    TIMEOUT,
  );

  it(
    'shows the project on the Board and pauses everything through pause.all',
    async () => {
      const { render, textOf } = await import('./page.js');
      const { App } = await import('../../src/app.js');
      const served = await deck.serve();
      const { container, unmount } = render(
        <App
          stream={{
            url: served.url,
            WebSocket: WsSocket as unknown as typeof WebSocket,
          }}
          intents={deck.client}
        />,
      );
      await vi.waitFor(() => {
        expect(textOf(container, '.qd-board-stream')).toBe('Stream live');
        expect(textOf(container, '.qd-board-project h3')).toBe(deck.project);
      });

      pressNamed(container, 'Pause all');
      await vi.waitFor(() => {
        expect(textOf(container, '.qd-board-outcome')).toBe(
          'Paused 1 project.',
        );
      });
      expect(await isGloballyPaused(deck.api.stores.dataHome)).toBe(true);

      pressNamed(container, 'Resume all');
      await vi.waitFor(() => {
        expect(textOf(container, '.qd-board-outcome')).toBe(
          'Resumed 1 project.',
        );
      });
      expect(await isGloballyPaused(deck.api.stores.dataHome)).toBe(false);
      unmount();
    },
    TIMEOUT,
  );
});
