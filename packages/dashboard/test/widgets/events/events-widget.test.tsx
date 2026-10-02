// @vitest-environment happy-dom
import type {
  StreamEvent,
  StreamMessage,
} from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { emptyTables } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/deck.js';
import { NOW_TICK_MS } from '../../../src/lib/use-now.js';
import { ALL } from '../../../src/widgets/events/event-feed.js';
import EVENTS_WIDGET, {
  EventsWidget,
} from '../../../src/widgets/events/events.widget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { choose } from '../../grid/events.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import { DECK, NOW, PROJECTS, SITE, ago, streamEvent } from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const MINUTE = 60_000;

const deliver = (...messages: StreamMessage[]): void => {
  const [socket] = FakeSocket.opened;
  if (socket === undefined) throw new Error('no socket opened');
  act(() => {
    messages.forEach((message) => socket.deliver(message));
  });
};

const snapshot = (): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects: PROJECTS },
  machine: { pausedAt: null },
});

const arrive = (event: StreamEvent): StreamMessage => ({
  type: 'event',
  event,
});

const mount = () =>
  render(
    <DeckProvider stream={stream}>
      <EventsWidget />
    </DeckProvider>,
  );

const filter = (scope: PageElement, label: string): PageElement => {
  const match = all(scope, '.qd-event-filter').find(
    (element) => element.querySelector('span')?.textContent === label,
  );
  const select = match?.querySelector('select') ?? null;
  if (select === null) throw new Error(`no ${label} filter`);
  return select;
};

const optionLabels = (select: PageElement): (string | null)[] =>
  all(select, 'option').map(({ textContent }) => textContent);

const rows = (scope: PageElement): string[] =>
  all(scope, '.qd-event-list li').map((row) =>
    [
      row.querySelector('code')?.textContent,
      row.querySelector('.qd-event-project')?.textContent,
      row.querySelector('time')?.textContent,
    ].join(' | '),
  );

describe('Events widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.opened = [];
  });

  it('registers as the events widget', () => {
    expect(WIDGETS.get('events')).toBe(EVENTS_WIDGET);
    expect(EVENTS_WIDGET.title).toBe('Events');
  });

  it('says so before any event arrives', () => {
    const { container, unmount } = mount();
    deliver(snapshot());
    expect(textOf(container, '.qd-empty')).toBe('No events yet.');
    expect(container.querySelector('.qd-event-list')).toBeNull();
    unmount();
  });

  it('lists events from the stream newest first with project and age', () => {
    const { container, unmount } = mount();
    deliver(
      snapshot(),
      arrive(streamEvent(1, 'project.created', DECK, ago(2 * 60 * MINUTE))),
      arrive(streamEvent(2, 'notebook.added', SITE, ago(5 * MINUTE))),
      arrive(streamEvent(3, 'notebook.added', DECK, ago(2000))),
    );
    expect(rows(container)).toEqual([
      'notebook.added | Deck | just now',
      'notebook.added | Site | 5m ago',
      'project.created | Deck | 2h ago',
    ]);
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(
      ago(2000),
    );
    unmount();
  });

  it('clamps an event stamped ahead of the clock to just now', () => {
    const { container, unmount } = mount();
    deliver(
      snapshot(),
      arrive(streamEvent(1, 'card.raised', DECK, ago(-30_000))),
    );
    expect(rows(container)).toEqual(['card.raised | Deck | just now']);
    unmount();
  });

  it('ages the rows as the clock moves on', () => {
    const { container, unmount } = mount();
    deliver(snapshot(), arrive(streamEvent(1, 'card.raised', DECK, ago(0))));
    expect(rows(container)).toEqual(['card.raised | Deck | just now']);
    act(() => {
      vi.advanceTimersByTime(4 * NOW_TICK_MS);
    });
    expect(rows(container)).toEqual(['card.raised | Deck | 1m ago']);
    unmount();
  });

  it('filters by project and by kind', () => {
    const { container, unmount } = mount();
    deliver(
      snapshot(),
      arrive(streamEvent(1, 'project.created', DECK, ago(3 * MINUTE))),
      arrive(streamEvent(2, 'notebook.added', SITE, ago(2 * MINUTE))),
      arrive(streamEvent(3, 'notebook.added', DECK, ago(MINUTE))),
    );
    expect(optionLabels(filter(container, 'Project'))).toEqual([
      'All projects',
      'Deck',
      'Site',
    ]);
    expect(optionLabels(filter(container, 'Kind'))).toEqual([
      'All kinds',
      'notebook.added',
      'project.created',
    ]);

    choose(filter(container, 'Project'), DECK);
    expect(rows(container)).toEqual([
      'notebook.added | Deck | 1m ago',
      'project.created | Deck | 3m ago',
    ]);

    choose(filter(container, 'Kind'), 'notebook.added');
    expect(rows(container)).toEqual(['notebook.added | Deck | 1m ago']);

    choose(filter(container, 'Project'), ALL);
    expect(rows(container)).toEqual([
      'notebook.added | Deck | 1m ago',
      'notebook.added | Site | 2m ago',
    ]);
    unmount();
  });

  it('says when the filters hide every event, and follows new ones', () => {
    const { container, unmount } = mount();
    deliver(
      snapshot(),
      arrive(streamEvent(1, 'project.created', DECK, ago(MINUTE))),
    );
    choose(filter(container, 'Project'), SITE);
    expect(textOf(container, '.qd-empty')).toBe(
      'No events match these filters.',
    );

    deliver(arrive(streamEvent(2, 'notebook.added', SITE, ago(0))));
    expect(rows(container)).toEqual(['notebook.added | Site | just now']);
    unmount();
  });

  it('keeps separate filters for each copy on the grid', () => {
    const { container, unmount } = render(
      <DeckProvider stream={stream}>
        <section data-copy="1">
          <EventsWidget />
        </section>
        <section data-copy="2">
          <EventsWidget />
        </section>
      </DeckProvider>,
    );
    deliver(
      snapshot(),
      arrive(streamEvent(1, 'project.created', DECK, ago(MINUTE))),
      arrive(streamEvent(2, 'notebook.added', SITE, ago(0))),
    );
    const copy = (n: number): PageElement => {
      const element = container.querySelector(`[data-copy="${n}"]`);
      if (element === null) throw new Error(`no copy ${n}`);
      return element;
    };
    choose(filter(copy(1), 'Kind'), 'project.created');
    expect(rows(copy(1))).toEqual(['project.created | Deck | 1m ago']);
    expect(rows(copy(2))).toHaveLength(2);
    unmount();
  });
});
