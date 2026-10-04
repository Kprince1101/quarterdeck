// @vitest-environment happy-dom
import { LAYOUT_PRESETS, type GridLayout } from '@quarterdeck/server/layouts';
import type { StreamMessage } from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient } from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/DeckProvider.js';
import { LAYOUT_LOADED } from '../../src/grid/grid-state.js';
import { LAYOUT_SAVE_DELAY_MS } from '../../src/layouts/constants.js';
import { DeckLayout } from '../../src/layouts/DeckLayout.js';
import {
  createRegistry,
  defineWidget,
  type WidgetProps,
} from '../../src/widgets/registry.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { choose, click, press } from '../grid/events.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';
import { layoutFrame, savedLayout, snapshotWith } from './stream-rows.js';

const Probe = ({ instanceId }: WidgetProps) => (
  <p data-probe={instanceId}>{instanceId}</p>
);

const probe = (type: string, title: string) =>
  defineWidget({ type, title, component: Probe, size: { w: 2, h: 2 } });

const WIDGETS = [
  probe('board', 'Board'),
  probe('planner', 'Planner'),
  probe('driver', 'Driver'),
  probe('notebook', 'Notebook'),
  probe('events', 'Events'),
];

const REGISTRY = createRegistry(WIDGETS);

const SAVED: GridLayout = {
  columns: 12,
  rows: 12,
  items: [
    { id: 'board-1', widget: 'board', x: 0, y: 0, w: 4, h: 4, hidden: false },
  ],
};

const boardAt = (y: number): GridLayout => ({
  ...SAVED,
  items: SAVED.items.map((entry) => ({ ...entry, y })),
});

interface Sent {
  intent: string;
  body: Record<string, unknown>;
  keepalive?: true;
}

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const setup = (status = 200, registry = REGISTRY, saveDelayMs = 0) => {
  const sent: Sent[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    const intent = String(url).split('/').at(-1) ?? '';
    const entry: Sent = { intent, body: JSON.parse(String(init?.body)) };
    if (init?.keepalive === true) entry.keepalive = true;
    sent.push(entry);
    const body = { intent, status: 'applied', id: null, result: null };
    if (status !== 200) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'layout refused' }), { status }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  const intents = createIntentClient({ fetch });
  const rendered = render(
    <DeckProvider stream={stream} intents={intents}>
      <DeckLayout registry={registry} saveDelayMs={saveDelayMs} />
    </DeckProvider>,
  );
  return { ...rendered, sent };
};

const deliver = (...messages: StreamMessage[]) => {
  act(() => {
    messages.forEach((message) => FakeSocket.opened[0]?.deliver(message));
  });
};

const settle = (ms = 5) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const cells = (scope: PageElement) =>
  all(scope, '[data-grid-item]').map((cell) =>
    cell.getAttribute('data-grid-item'),
  );

const find = (scope: PageElement, selector: string): PageElement => {
  const found = scope.querySelector(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};

const announced = (scope: PageElement) => textOf(scope, '[aria-live="polite"]');

describe('deck layout', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('starts on the default preset with Planner, Driver and Notebook as tabs in one slot', () => {
    const { container, unmount } = setup();
    expect(cells(container)).toEqual(['board-1', 'planner-1', 'events-1']);
    const slot = find(container, '[data-grid-item="planner-1"]');
    expect(textOf(slot, '.qd-panel-title')).toBe('Planner');
    expect(find(slot, '[role="tablist"]').getAttribute('aria-label')).toBe(
      'Planner',
    );
    expect(all(slot, '[role="tab"]').map((tab) => tab.textContent)).toEqual([
      'Planner',
      'Driver',
      'Notebook',
    ]);
    const probes = () =>
      all(slot, '[role="tabpanel"] [data-probe]').map((pane) =>
        pane.getAttribute('data-probe'),
      );
    expect(probes()).toEqual(['planner-1']);
    click(find(slot, '[role="tab"]:nth-child(2)'));
    expect(probes()).toEqual(['planner-1:driver']);
    press(find(slot, '[role="tab"][aria-selected="true"]'), 'ArrowRight');
    expect(probes()).toEqual(['planner-1:notebook']);
    expect(
      find(container, '[data-grid-item="board-1"]').querySelector(
        '[role="tablist"]',
      ),
    ).toBe(null);
    unmount();
  });

  it('shows the tabs that have landed when the first widget of a slot has not', () => {
    const { container, unmount } = setup(
      200,
      createRegistry(WIDGETS.filter(({ type }) => type !== 'planner')),
    );
    const slot = find(container, '[data-grid-item="planner-1"]');
    expect(textOf(slot, '.qd-panel-title')).toBe('Driver');
    expect(all(slot, '[role="tab"]').map((tab) => tab.textContent)).toEqual([
      'Driver',
      'Notebook',
    ]);
    expect(textOf(slot, '[role="tabpanel"] [data-probe]')).toBe(
      'planner-1:driver',
    );
    click(find(slot, '[aria-label="Hide Driver"]'));
    expect(textOf(container, '[data-hidden-item="planner-1"]')).toContain(
      'Driver',
    );
    unmount();
  });

  it('loads the layout the server holds once the snapshot arrives', () => {
    const { container, unmount } = setup();
    deliver(snapshotWith(savedLayout(SAVED)));
    expect(cells(container)).toEqual(['board-1']);
    expect(announced(container)).toBe(LAYOUT_LOADED);
    unmount();
  });

  it('keeps the preset when the stored layout is not one the grid can show', () => {
    const { container, unmount } = setup();
    deliver(snapshotWith(savedLayout({ columns: 12, items: [] })));
    expect(cells(container)).toEqual(['board-1', 'planner-1', 'events-1']);
    unmount();
  });

  it('saves each edit through layout.save and ignores its own echo', async () => {
    const { container, unmount, sent } = setup();
    deliver(snapshotWith(savedLayout(SAVED)));
    const handle = find(container, '[aria-label="Move Board"]');
    press(handle, 'ArrowDown');
    await settle();
    expect(sent).toEqual([
      {
        intent: 'layout.save',
        body: { name: 'dashboard', spec: boardAt(1) },
      },
    ]);
    press(handle, 'ArrowDown');
    deliver(layoutFrame(boardAt(1)));
    expect(announced(container)).toBe('Board moved to column 1, row 3.');
    await settle();
    expect(sent.map(({ body }) => body['spec'])).toEqual([
      boardAt(1),
      boardAt(2),
    ]);
    unmount();
  });

  it('follows a layout changed somewhere else', () => {
    const { container, unmount } = setup();
    deliver(snapshotWith(savedLayout(SAVED)));
    deliver(layoutFrame(LAYOUT_PRESETS.default));
    expect(cells(container)).toEqual(['board-1', 'planner-1', 'events-1']);
    expect(announced(container)).toBe(LAYOUT_LOADED);
    unmount();
  });

  it('resets to the chosen preset at once and through layout.reset', async () => {
    const { container, unmount, sent } = setup();
    deliver(snapshotWith(savedLayout(SAVED)));
    const options = all(container, '[aria-label="Layout preset"] option').map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['Default', 'Ops', 'Minimal']);
    choose(find(container, '[aria-label="Layout preset"]'), 'minimal');
    click(find(container, '.qd-layout-bar button'));
    expect(cells(container)).toEqual(['board-1']);
    expect(
      find(container, '[data-grid-item="board-1"]').getAttribute('style'),
    ).toContain('span 8');
    await settle();
    expect(sent).toEqual([
      {
        intent: 'layout.reset',
        body: { name: 'dashboard', preset: 'minimal' },
      },
    ]);
    deliver(layoutFrame(LAYOUT_PRESETS.minimal));
    expect(cells(container)).toEqual(['board-1']);
    unmount();
  });

  it('resets again after edits even to the same preset', () => {
    const { container, unmount } = setup();
    click(find(container, '[aria-label="Hide Board"]'));
    expect(cells(container)).toEqual(['planner-1', 'events-1']);
    click(find(container, '.qd-layout-bar button'));
    expect(cells(container)).toEqual(['board-1', 'planner-1', 'events-1']);
    unmount();
  });

  it('sends an edit made just before the page closes, with keepalive', async () => {
    const { container, unmount, sent } = setup(
      200,
      REGISTRY,
      LAYOUT_SAVE_DELAY_MS,
    );
    deliver(snapshotWith(savedLayout(SAVED)));
    press(find(container, '[aria-label="Move Board"]'), 'ArrowDown');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    const moved = {
      intent: 'layout.save',
      body: { name: 'dashboard', spec: boardAt(1) },
      keepalive: true,
    };
    expect(sent).toEqual([moved]);
    await settle(LAYOUT_SAVE_DELAY_MS + 50);
    expect(sent).toEqual([moved]);
    unmount();
  });

  it('sends a pending edit with keepalive when the tab is hidden', () => {
    const { container, unmount, sent } = setup(
      200,
      REGISTRY,
      LAYOUT_SAVE_DELAY_MS,
    );
    deliver(snapshotWith(savedLayout(SAVED)));
    press(find(container, '[aria-label="Move Board"]'), 'ArrowDown');
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();
    expect(sent).toEqual([
      {
        intent: 'layout.save',
        body: { name: 'dashboard', spec: boardAt(1) },
        keepalive: true,
      },
    ]);
    unmount();
  });

  it('keeps an edit made before the snapshot and saves it once the snapshot arrives', async () => {
    const { container, unmount, sent } = setup();
    click(find(container, '[aria-label="Hide Board"]'));
    await settle();
    expect(sent).toEqual([]);
    deliver(snapshotWith(savedLayout(SAVED)));
    expect(cells(container)).toEqual(['planner-1', 'events-1']);
    expect(announced(container)).not.toBe(LAYOUT_LOADED);
    await settle();
    expect(sent).toHaveLength(1);
    const [save] = sent;
    expect(save?.intent).toBe('layout.save');
    const spec = save?.body['spec'] as GridLayout;
    expect(save?.body).toEqual({ name: 'dashboard', spec });
    expect(spec.items.find(({ id }) => id === 'board-1')?.hidden).toBe(true);
    deliver(layoutFrame(spec));
    expect(cells(container)).toEqual(['planner-1', 'events-1']);
    expect(announced(container)).not.toBe(LAYOUT_LOADED);
    unmount();
  });

  it('keeps a reset made before the snapshot and sends it once the snapshot arrives', async () => {
    const { container, unmount, sent } = setup();
    choose(find(container, '[aria-label="Layout preset"]'), 'minimal');
    click(find(container, '.qd-layout-bar button'));
    await settle();
    expect(sent).toEqual([]);
    deliver(snapshotWith(savedLayout(SAVED)));
    await settle();
    expect(sent).toEqual([
      {
        intent: 'layout.reset',
        body: { name: 'dashboard', preset: 'minimal' },
      },
    ]);
    expect(
      find(container, '[data-grid-item="board-1"]').getAttribute('style'),
    ).toContain('span 8');
    unmount();
  });

  it('shows why a save was refused', async () => {
    const { container, unmount } = setup(400);
    deliver(snapshotWith(savedLayout(SAVED)));
    click(find(container, '[aria-label="Hide Board"]'));
    await settle();
    expect(textOf(container, '[role="alert"]')).toBe('layout refused');
    unmount();
  });
});
