// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NewestMarker,
  TabBar,
  TabPanel,
  useTabs,
  type TabSpec,
} from '../../src/primitives/index.js';
import {
  activeElement,
  click,
  find,
  findAll,
  mount,
  press,
  type DomElement,
  type Mounted,
} from './dom.js';
import { FakeObserver, installObserver } from './fake-observer.js';

interface DeckTabsProps {
  specs: TabSpec[];
  ready?: boolean;
  initial?: string;
}

const DeckTabs = ({ specs, ready, initial }: DeckTabsProps) => {
  const view = useTabs({ tabs: specs, ready, initial });
  return (
    <section>
      <TabBar label="Deck" tabs={view.tabs} onKeyDown={view.handleKeyDown} />
      <TabPanel panel={view.panel}>
        <p className="active">{view.activeId}</p>
        <NewestMarker {...view.marker} />
      </TabPanel>
    </section>
  );
};

const specs = (planner: string | null, driver: number | null): TabSpec[] => [
  { id: 'planner', label: 'Planner', newest: planner },
  { id: 'driver', label: 'Driver', newest: driver },
  { id: 'notebook', label: 'Notebook', newest: null },
];

const tab = (scope: DomElement, label: string): DomElement => {
  const match = findAll(scope, '[role="tab"]').find(
    (element) => element.querySelector('.qd-tab-label')?.textContent === label,
  );
  if (match === undefined) throw new Error(`no ${label} tab`);
  return match;
};

const unreadTabs = (scope: DomElement): string[] =>
  findAll(scope, '[role="tab"][data-unread="true"]').map(
    (element) => element.querySelector('.qd-tab-label')?.textContent ?? '',
  );

const activeTab = (scope: DomElement): string =>
  find(scope, '.active').textContent ?? '';

let view: Mounted;
let restore: () => void;

describe('TabBar', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  beforeEach(() => {
    restore = installObserver(FakeObserver);
  });

  afterEach(() => {
    view.unmount();
    restore();
  });

  it('renders a labelled tablist wired to its panel', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    const { container } = view;
    expect(find(container, '[role="tablist"]').getAttribute('aria-label')).toBe(
      'Deck',
    );
    const tabs = findAll(container, '[role="tab"]');
    expect(tabs.map(({ textContent }) => textContent)).toEqual([
      'Planner',
      'Driver',
      'Notebook',
    ]);
    expect(
      tabs.map((element) => element.getAttribute('aria-selected')),
    ).toEqual(['true', 'false', 'false']);
    expect(tabs.map((element) => element.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ]);
    const panel = find(container, '[role="tabpanel"]');
    expect(
      tabs.map((element) => element.getAttribute('aria-controls')),
    ).toEqual([panel.getAttribute('id'), null, null]);
    expect(panel.getAttribute('aria-labelledby')).toBe(
      tab(container, 'Planner').getAttribute('id'),
    );
  });

  it('switches tabs on click', async () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    await click(tab(view.container, 'Driver'));
    expect(activeTab(view.container)).toBe('driver');
    expect(tab(view.container, 'Driver').getAttribute('aria-selected')).toBe(
      'true',
    );
    const panel = find(view.container, '[role="tabpanel"]');
    expect(tab(view.container, 'Driver').getAttribute('aria-controls')).toBe(
      panel.getAttribute('id'),
    );
    expect(panel.getAttribute('aria-labelledby')).toBe(
      tab(view.container, 'Driver').getAttribute('id'),
    );
    expect(tab(view.container, 'Planner').hasAttribute('aria-controls')).toBe(
      false,
    );
  });

  it('moves selection and focus with the arrow keys, Home and End', async () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    const { container } = view;
    const right = await press(tab(container, 'Planner'), 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(activeTab(container)).toBe('driver');
    expect(activeElement()).toBe(tab(container, 'Driver'));

    await press(tab(container, 'Driver'), 'End');
    expect(activeTab(container)).toBe('notebook');
    await press(tab(container, 'Notebook'), 'ArrowRight');
    expect(activeTab(container)).toBe('planner');
    await press(tab(container, 'Planner'), 'ArrowLeft');
    expect(activeTab(container)).toBe('notebook');
    await press(tab(container, 'Notebook'), 'Home');
    expect(activeTab(container)).toBe('planner');
    expect(activeElement()).toBe(tab(container, 'Planner'));

    const other = await press(tab(container, 'Planner'), 'a');
    expect(other.defaultPrevented).toBe(false);
  });

  it('opens on the initial tab and falls back when a tab goes away', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} initial="driver" />);
    expect(activeTab(view.container)).toBe('driver');
    view.rerender(
      <DeckTabs specs={specs('p1', 1).slice(0, 1)} initial="driver" />,
    );
    expect(activeTab(view.container)).toBe('planner');
  });
});

describe('TabBar unread', () => {
  beforeEach(() => {
    restore = installObserver(FakeObserver);
  });

  afterEach(() => {
    view.unmount();
    restore();
  });

  it('treats what was there when it mounted as read', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    expect(unreadTabs(view.container)).toEqual([]);
  });

  it('lights an inactive tab when its newest item changes', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    view.rerender(<DeckTabs specs={specs('p1', 2)} />);
    expect(unreadTabs(view.container)).toEqual(['Driver']);
    expect(
      find(tab(view.container, 'Driver'), '.qd-tab-unread').textContent,
    ).toBe('unread');
  });

  it('clears a tab once its newest item comes into view', async () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    view.rerender(<DeckTabs specs={specs('p1', 2)} />);
    await click(tab(view.container, 'Driver'));
    expect(unreadTabs(view.container)).toEqual(['Driver']);

    FakeObserver.only().report(false);
    expect(unreadTabs(view.container)).toEqual(['Driver']);
    FakeObserver.only().report(true);
    expect(unreadTabs(view.container)).toEqual([]);
  });

  it('lights the active tab while its newest item is scrolled out of view', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    FakeObserver.only().report(true);
    view.rerender(<DeckTabs specs={specs('p2', 1)} />);
    expect(unreadTabs(view.container)).toEqual(['Planner']);

    const marker = FakeObserver.only();
    expect(marker.targets).toEqual([
      find(view.container, '[data-newest-marker]'),
    ]);
    marker.report(false);
    expect(unreadTabs(view.container)).toEqual(['Planner']);
    marker.report(true);
    expect(unreadTabs(view.container)).toEqual([]);
  });

  it('watches the marker afresh for every new item', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    const first = FakeObserver.only();
    view.rerender(<DeckTabs specs={specs('p2', 1)} />);
    expect(first.disconnected).toBe(true);
    expect(FakeObserver.only()).not.toBe(first);
  });

  it('watches afresh when switching to a tab whose newest key matches', async () => {
    const sameKeys = (driver: string | null): TabSpec[] => [
      { id: 'planner', label: 'Planner', newest: 'k7' },
      { id: 'driver', label: 'Driver', newest: driver },
    ];
    view = mount(<DeckTabs specs={sameKeys(null)} />);
    const planner = FakeObserver.only();
    planner.report(true);
    view.rerender(<DeckTabs specs={sameKeys('k7')} />);
    expect(unreadTabs(view.container)).toEqual(['Driver']);

    await click(tab(view.container, 'Driver'));
    expect(planner.disconnected).toBe(true);
    const driver = FakeObserver.only();
    expect(driver).not.toBe(planner);
    expect(unreadTabs(view.container)).toEqual(['Driver']);
    driver.report(true);
    expect(unreadTabs(view.container)).toEqual([]);
  });

  it('does not count history that arrives before the stream is ready', () => {
    view = mount(<DeckTabs specs={specs(null, null)} ready={false} />);
    view.rerender(<DeckTabs specs={specs('p9', 40)} ready={false} />);
    expect(unreadTabs(view.container)).toEqual([]);
    view.rerender(<DeckTabs specs={specs('p9', 40)} ready />);
    expect(unreadTabs(view.container)).toEqual([]);
    view.rerender(<DeckTabs specs={specs('p9', 41)} ready />);
    expect(unreadTabs(view.container)).toEqual(['Driver']);
  });

  it('counts the newest item as seen when the page cannot observe', () => {
    restore();
    restore = installObserver(undefined);
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    view.rerender(<DeckTabs specs={specs('p2', 2)} />);
    expect(unreadTabs(view.container)).toEqual(['Driver']);
  });

  it('stops observing when it unmounts', () => {
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
    const marker = FakeObserver.only();
    view.unmount();
    expect(marker.disconnected).toBe(true);
    view = mount(<DeckTabs specs={specs('p1', 1)} />);
  });
});
