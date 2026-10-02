import { LAYOUT_PRESETS, parseGridLayout } from '@quarterdeck/server/layouts';
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

const element = (container: PageElement, selector: string): HappyElement => {
  const found = container.querySelector(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found as unknown as HappyElement;
};

describe('dashboard on a live server', () => {
  const window = new Window();
  let deck: Deck;

  const savedLayout = async (): Promise<unknown> => {
    const { rows } = await deck.store.db.query<{ spec: unknown }>(
      'select spec from layouts where name = $1',
      [DASHBOARD_LAYOUT],
    );
    return rows.map((row) => parseGridLayout(row.spec));
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
      expect(container.querySelector('[data-grid-item="events-1"]')).not.toBe(
        null,
      );
      expect(container.querySelector('.qd-table-counts')).toBe(null);

      await deck.client.layout.save({
        project: deck.project,
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
      expect(container.querySelector('[data-grid-item]')).toBe(null);
      unmount();
    },
    TIMEOUT,
  );
});
