import { isGloballyPaused, readGlobalLayout } from '@quarterdeck/server';
import { LAYOUT_PRESETS } from '@quarterdeck/server/layouts';
import {
  Window,
  type HTMLElement as HappyElement,
  type HTMLSelectElement as HappySelect,
} from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsSocket } from 'ws';
import { DASHBOARD_LAYOUT } from '../../src/layouts/constants.js';
import { TIMEOUT, startDeck, type Deck } from '../api/harness.js';
import { STARTER_LAYOUT } from '../layouts/stream-rows.js';
import type { PageElement } from './page.js';

const WAIT = { timeout: 5000 };

const pressNamed = (container: PageElement, name: string): void => {
  const button = Array.from(container.querySelectorAll('button')).find(
    ({ textContent }) => textContent === name,
  );
  if (button === undefined) throw new Error(`no ${name} button`);
  (button as unknown as HappyElement).click();
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

const renderedWidgets = (
  all: typeof import('./page.js').all,
  container: PageElement,
): (string | null)[] =>
  all(container, '[data-widget]').map((cell) =>
    cell.getAttribute('data-widget'),
  );

const element = (container: PageElement, selector: string): HappyElement => {
  const found = container.querySelector(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found as unknown as HappyElement;
};

describe('dashboard on a live server', () => {
  const window = new Window();
  let deck: Deck;

  const savedLayout = async (): Promise<unknown> => {
    const saved = await readGlobalLayout(deck.api.stores.dataHome);
    return [saved?.spec];
  };

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
    'goes live, loads the saved layout and follows intents sent through the typed client',
    async () => {
      const { all, render, textOf } = await import('./page.js');
      const { App } = await import('../../src/App.js');
      const served = await deck.serve();
      const { container, unmount } = render(
        <App
          stream={{
            url: served.url,
            token: deck.api.token,
            WebSocket: WsSocket as unknown as typeof WebSocket,
          }}
          intents={deck.client}
        />,
      );
      await vi.waitFor(() => {
        expect(textOf(container, '[role="status"]')).toBe('Live');
      });
      expect(container.querySelector('[data-grid-item="events-1"]')).not.toBe(
        null,
      );
      expect(container.querySelector('.qd-table-counts')).toBe(null);

      await deck.client.layout.save({
        name: DASHBOARD_LAYOUT,
        spec: STARTER_LAYOUT,
      });
      await vi.waitFor(() => {
        expect(count(all, container, 'notebook')).toBe('0');
      }, WAIT);

      await deck.client.notebook.add({ project: deck.project, body: 'hi' });
      await vi.waitFor(() => {
        expect(count(all, container, 'notebook')).toBe('1');
        expect(textOf(container, '.qd-event-list code')).toBe('notebook.add');
      }, WAIT);

      element(container, '[aria-label="Hide Tables"]').click();
      await vi.waitFor(async () => {
        const [saved] = (await savedLayout()) as [typeof STARTER_LAYOUT];
        expect(saved.items.find(({ id }) => id === 'tables-1')?.hidden).toBe(
          true,
        );
      }, WAIT);

      const preset = element(
        container,
        '[aria-label="Layout preset"]',
      ) as HappySelect;
      preset.value = 'minimal';
      preset.dispatchEvent(new window.Event('change', { bubbles: true }));
      element(container, '.qd-layout-bar button').click();
      await vi.waitFor(async () => {
        expect(await savedLayout()).toEqual([LAYOUT_PRESETS.minimal]);
      }, WAIT);
      const { WIDGETS } = await import('../../src/widgets/widgets.js');
      expect(renderedWidgets(all, container)).toEqual(
        LAYOUT_PRESETS.minimal.items
          .map(({ widget }) => widget)
          .filter((widget) => WIDGETS.has(widget)),
      );
      unmount();
    },
    TIMEOUT,
  );

  it(
    'loads a layout edited in one client into a second one',
    async () => {
      const { all, render } = await import('./page.js');
      const { App } = await import('../../src/App.js');
      await deck.client.layout.save({
        name: DASHBOARD_LAYOUT,
        spec: STARTER_LAYOUT,
      });
      const open = async () => {
        const served = await deck.serve();
        return render(
          <App
            stream={{
              url: served.url,
              token: deck.api.token,
              WebSocket: WsSocket as unknown as typeof WebSocket,
            }}
            intents={deck.client}
          />,
        );
      };
      const cells = (container: PageElement) =>
        all(container, '[data-grid-item]').map((cell) =>
          cell.getAttribute('data-grid-item'),
        );
      const first = await open();
      const second = await open();
      await vi.waitFor(() => {
        expect(cells(first.container)).toEqual(['events-1', 'tables-1']);
        expect(cells(second.container)).toEqual(['events-1', 'tables-1']);
      }, WAIT);

      element(first.container, '[aria-label="Hide Tables"]').click();
      await vi.waitFor(() => {
        expect(cells(second.container)).toEqual(['events-1']);
      }, WAIT);
      expect(cells(first.container)).toEqual(['events-1']);
      first.unmount();
      second.unmount();
    },
    TIMEOUT,
  );

  it(
    'reads counts, rows and paths from the server in the Data widget',
    async () => {
      const { all, render, textOf } = await import('./page.js');
      const { App } = await import('../../src/App.js');
      const { flushSync } = await import('react-dom');
      const press = (element: PageElement) => {
        flushSync(() => {
          (element as unknown as HappyElement).click();
        });
      };
      const served = await deck.serve();
      const { container, unmount } = render(
        <App
          stream={{
            url: served.url,
            token: deck.api.token,
            WebSocket: WsSocket as unknown as typeof WebSocket,
          }}
          intents={deck.client}
        />,
      );
      await vi.waitFor(() => {
        expect(textOf(container, '[role="status"]')).toBe('Live');
      });
      await deck.client.layout.save({
        name: DASHBOARD_LAYOUT,
        spec: {
          columns: 12,
          rows: 12,
          items: [
            {
              id: 'data-1',
              widget: 'data',
              x: 0,
              y: 0,
              w: 12,
              h: 12,
              hidden: false,
            },
          ],
        },
      });
      const notebook = () =>
        all(container, '.qd-data-tables button').find(
          (button) => button.querySelector('span')?.textContent === 'notebook',
        );
      await vi.waitFor(() => {
        expect(notebook()?.querySelector('.qd-data-count')?.textContent).toBe(
          '1',
        );
        expect(textOf(container, '.qd-data-paths code')).toContain(
          `${deck.project}/pg`,
        );
      });

      const button = notebook();
      if (button === undefined) throw new Error('no notebook button');
      press(button);
      await vi.waitFor(() => {
        expect(textOf(container, '.qd-data-range')).toBe('1–1 of 1');
        expect(container.querySelector('.qd-data-rows')?.textContent).toContain(
          'hi',
        );
      });
      unmount();
    },
    TIMEOUT,
  );

  it(
    'shows the project on the Board and pauses everything through pause.all',
    async () => {
      const { all, render, textOf } = await import('./page.js');
      const { App } = await import('../../src/App.js');
      const { WIDGETS } = await import('../../src/widgets/widgets.js');
      const served = await deck.serve();
      const { container, unmount } = render(
        <App
          stream={{
            url: served.url,
            token: deck.api.token,
            WebSocket: WsSocket as unknown as typeof WebSocket,
          }}
          intents={deck.client}
        />,
      );
      await vi.waitFor(() => {
        expect(textOf(container, '[role="status"]')).toBe('Live');
      });
      await deck.client.layout.save({
        name: DASHBOARD_LAYOUT,
        spec: LAYOUT_PRESETS.minimal,
      });
      const minimalWidgets = LAYOUT_PRESETS.minimal.items
        .map(({ widget }) => widget)
        .filter((widget) => WIDGETS.has(widget));
      await vi.waitFor(() => {
        expect(renderedWidgets(all, container)).toEqual(minimalWidgets);
        expect(textOf(container, '.qd-board-stream')).toBe('Stream live');
        expect(textOf(container, '.qd-board-project h3')).toBe(deck.project);
      }, WAIT);

      expect(container.querySelector('.qd-board-paused')).toBeNull();

      pressNamed(container, 'Pause all');
      await vi.waitFor(() => {
        expect(textOf(container, '.qd-board-outcome')).toBe(
          'Paused 1 project.',
        );
        expect(textOf(container, '.qd-board-paused')).toBe('Paused everywhere');
      }, WAIT);
      expect(await isGloballyPaused(deck.api.stores.dataHome)).toBe(true);

      pressNamed(container, 'Resume all');
      await vi.waitFor(() => {
        expect(textOf(container, '.qd-board-outcome')).toBe(
          'Resumed 1 project.',
        );
        expect(container.querySelector('.qd-board-paused')).toBeNull();
      }, WAIT);
      expect(await isGloballyPaused(deck.api.stores.dataHome)).toBe(false);
      unmount();
    },
    TIMEOUT,
  );
});
