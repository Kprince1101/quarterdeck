// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeckProvider } from '../../src/deck/deck.js';
import type { GridLayout } from '../../src/grid/layout.js';
import { WidgetMount } from '../../src/widgets/widget-mount.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';
import { choose, click, point, press, stubSize } from './events.js';
import { board, item, REGISTRY } from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const mount = (initialLayout?: GridLayout) =>
  render(
    <DeckProvider stream={stream}>
      <WidgetMount registry={REGISTRY} initialLayout={initialLayout} />
    </DeckProvider>,
  );

const find = (scope: PageElement, selector: string): PageElement => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
};

const cell = (scope: PageElement, id: string): PageElement =>
  find(scope, `[data-grid-item="${id}"]`);

const area = (scope: PageElement, id: string): string => {
  const style = cell(scope, id).getAttribute('style') ?? '';
  return style.replaceAll(/\s+/g, ' ').trim();
};

const cells = (scope: PageElement): (string | null)[] =>
  all(scope, '[data-grid-item]').map((element) =>
    element.getAttribute('data-grid-item'),
  );

const announced = (scope: PageElement): string =>
  textOf(scope, '[aria-live="polite"]');

describe('widget grid', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('places every registered widget in its own titled panel', () => {
    const { container, unmount } = mount();
    expect(cells(container)).toEqual(['alpha-1', 'beta-1']);
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 4; grid-row: 1 / span 4;',
    );
    expect(textOf(cell(container, 'beta-1'), '.qd-panel-title')).toBe('Beta');
    expect(textOf(cell(container, 'beta-1'), '[data-probe]')).toBe('beta-1');
    unmount();
  });

  it('moves a widget with the arrow keys on its move handle', () => {
    const { container, unmount } = mount();
    const handle = find(container, '[aria-label="Move Alpha"]');
    expect(handle.getAttribute('aria-keyshortcuts')).toBe(
      'ArrowLeft ArrowRight ArrowUp ArrowDown',
    );
    press(handle, 'ArrowDown');
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 4; grid-row: 2 / span 4;',
    );
    expect(announced(container)).toBe('Alpha moved to column 1, row 2.');
    press(handle, 'ArrowRight');
    expect(announced(container)).toBe('Alpha cannot move further that way.');
    press(handle, 'Enter');
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 4; grid-row: 2 / span 4;',
    );
    unmount();
  });

  it('steps a widget over its neighbour with the arrow keys', () => {
    const { container, unmount } = mount(
      board(
        item('alpha-1', { x: 0, y: 0, w: 2, h: 2 }),
        item('beta-1', { x: 2, y: 0, w: 3, h: 2 }),
      ),
    );
    press(find(container, '[aria-label="Move Alpha"]'), 'ArrowRight');
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 6 / span 2; grid-row: 1 / span 2;',
    );
    unmount();
  });

  it('resizes a widget with the arrow keys on its resize handle', () => {
    const { container, unmount } = mount();
    const handle = find(container, '[aria-label="Resize Alpha"]');
    press(handle, 'ArrowDown');
    press(handle, 'ArrowLeft');
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 3; grid-row: 1 / span 5;',
    );
    press(handle, 'ArrowRight');
    press(handle, 'ArrowRight');
    expect(announced(container)).toBe('Alpha cannot take that size there.');
    unmount();
  });

  it('drags a widget and its corner with the pointer, cell by cell', () => {
    const { container, unmount } = mount();
    stubSize(find(container, '.qd-grid'), 1200, 600);
    const move = find(container, '[aria-label="Move Alpha"]');
    point(move, 'pointerdown', 50, 20);
    point(move, 'pointermove', 60, 130);
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 4; grid-row: 3 / span 4;',
    );
    point(move, 'pointermove', 70, 320);
    point(move, 'pointerup', 70, 320);
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 4; grid-row: 7 / span 4;',
    );
    point(move, 'pointermove', 400, 400);
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 4; grid-row: 7 / span 4;',
    );

    const corner = find(container, '[aria-label="Resize Alpha"]');
    point(corner, 'pointerdown', 400, 450);
    point(corner, 'pointermove', 610, 400);
    point(corner, 'pointerup', 610, 400);
    expect(area(container, 'alpha-1')).toBe(
      'grid-column: 1 / span 6; grid-row: 7 / span 3;',
    );
    unmount();
  });

  it('hides a widget into the tray and shows it again', () => {
    const { container, unmount } = mount();
    click(find(container, '[aria-label="Hide Beta"]'));
    expect(cells(container)).toEqual(['alpha-1']);
    expect(announced(container)).toBe('Beta hidden.');
    expect(textOf(container, '[data-hidden-item="beta-1"]')).toContain('Beta');

    click(find(container, '[aria-label="Show Beta"]'));
    expect(cells(container)).toEqual(['alpha-1', 'beta-1']);
    expect(container.querySelector('[data-hidden-item]')).toBe(null);
    unmount();
  });

  it('removes a hidden widget for good', () => {
    const { container, unmount } = mount();
    click(find(container, '[aria-label="Hide Beta"]'));
    click(find(container, '[aria-label="Remove Beta"]'));
    expect(cells(container)).toEqual(['alpha-1']);
    expect(container.querySelector('[data-hidden-item]')).toBe(null);
    unmount();
  });

  it('duplicates a widget into the next free spot', () => {
    const { container, unmount } = mount();
    click(find(container, '[aria-label="Duplicate Alpha"]'));
    expect(cells(container)).toEqual(['alpha-1', 'beta-1', 'alpha-2']);
    expect(textOf(cell(container, 'alpha-2'), '.qd-panel-title')).toBe(
      'Alpha 2',
    );
    expect(textOf(cell(container, 'alpha-2'), '[data-probe]')).toBe('alpha-2');
    unmount();
  });

  it('adds any registered widget from the tray', () => {
    const { container, unmount } = mount(board());
    expect(cells(container)).toEqual([]);
    const options = all(container, '[aria-label="Widget to add"] option').map(
      ({ textContent }) => textContent,
    );
    expect(options).toEqual(['Alpha', 'Beta']);
    choose(find(container, '[aria-label="Widget to add"]'), 'beta');
    click(find(container, '.qd-grid-add button'));
    expect(cells(container)).toEqual(['beta-1']);
    expect(announced(container)).toBe('Beta added.');
    unmount();
  });

  it('starts from a given layout and skips widgets nobody registered', () => {
    const { container, unmount } = mount(
      board(
        item('beta-1', { x: 6, y: 6, w: 6, h: 6 }),
        item('gamma-1', { x: 0, y: 0, w: 2, h: 2 }),
      ),
    );
    expect(cells(container)).toEqual(['beta-1']);
    expect(area(container, 'beta-1')).toBe(
      'grid-column: 7 / span 6; grid-row: 7 / span 6;',
    );
    unmount();
  });

  it('describes each handle for screen readers', () => {
    const { container, unmount } = mount();
    const move = find(container, '[aria-label="Move Alpha"]');
    const helpId = move.getAttribute('aria-describedby') ?? '';
    const help = all(container, '[hidden]').find(
      (element) => element.getAttribute('id') === helpId,
    );
    expect(help?.textContent).toBe(
      'Arrow keys move the widget to the next free cell.',
    );
    all(container, '.qd-grid-cell button').forEach((button) => {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-label')).toBeTruthy();
    });
    unmount();
  });
});
