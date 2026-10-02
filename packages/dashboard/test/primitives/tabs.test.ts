import { describe, expect, it } from 'vitest';
import {
  isUnread,
  markSeenKey,
  resolveActiveTab,
  seenKeysOf,
  tabAfterKey,
  tabIndexOf,
  type TabSpec,
} from '../../src/primitives/index.js';

const TABS: TabSpec[] = [
  { id: 'planner', label: 'Planner', newest: 'p2' },
  { id: 'driver', label: 'Driver', newest: 7 },
  { id: 'notebook', label: 'Notebook', newest: null },
];

describe('resolveActiveTab', () => {
  it('keeps a selected tab that exists', () => {
    expect(resolveActiveTab(TABS, 'driver')).toBe('driver');
  });

  it('falls back to the first tab', () => {
    expect(resolveActiveTab(TABS, null)).toBe('planner');
    expect(resolveActiveTab(TABS, 'gone')).toBe('planner');
  });

  it('has nothing to show without tabs', () => {
    expect(resolveActiveTab([], 'planner')).toBeNull();
  });
});

describe('tabAfterKey', () => {
  it('steps with the arrow keys and wraps', () => {
    expect(tabAfterKey(TABS, 'planner', 'ArrowRight')).toBe('driver');
    expect(tabAfterKey(TABS, 'notebook', 'ArrowRight')).toBe('planner');
    expect(tabAfterKey(TABS, 'planner', 'ArrowLeft')).toBe('notebook');
    expect(tabAfterKey(TABS, 'driver', 'ArrowLeft')).toBe('planner');
  });

  it('jumps to the ends with Home and End', () => {
    expect(tabAfterKey(TABS, 'driver', 'Home')).toBe('planner');
    expect(tabAfterKey(TABS, 'driver', 'End')).toBe('notebook');
  });

  it('ignores other keys and unknown tabs', () => {
    expect(tabAfterKey(TABS, 'planner', 'Enter')).toBeNull();
    expect(tabAfterKey(TABS, 'gone', 'ArrowRight')).toBeNull();
    expect(tabAfterKey([], null, 'ArrowRight')).toBeNull();
  });
});

describe('unread', () => {
  const seen = seenKeysOf(TABS);

  it('reads nothing as unread before the baseline', () => {
    TABS.forEach((tab) => expect(isUnread(tab, null)).toBe(false));
  });

  it('treats what was there at the baseline as read', () => {
    expect(seen).toEqual({ planner: 'p2', driver: 7, notebook: null });
    TABS.forEach((tab) => expect(isUnread(tab, seen)).toBe(false));
  });

  it('marks a tab unread when its newest item changes', () => {
    expect(isUnread({ id: 'driver', label: 'Driver', newest: 8 }, seen)).toBe(
      true,
    );
    expect(
      isUnread({ id: 'notebook', label: 'Notebook', newest: 'n1' }, seen),
    ).toBe(true);
  });

  it('marks a tab added after the baseline unread once it has items', () => {
    expect(isUnread({ id: 'cards', label: 'Cards', newest: null }, seen)).toBe(
      false,
    );
    expect(isUnread({ id: 'cards', label: 'Cards', newest: 1 }, seen)).toBe(
      true,
    );
  });

  it('clears a tab once its newest item is seen', () => {
    const next = markSeenKey(seen, 'driver', 8);
    expect(isUnread({ id: 'driver', label: 'Driver', newest: 8 }, next)).toBe(
      false,
    );
  });

  it('keeps the same object when nothing changes', () => {
    expect(markSeenKey(seen, 'driver', 7)).toBe(seen);
    expect(markSeenKey(null, 'driver', 8)).toBeNull();
  });
});

describe('tabIndexOf', () => {
  it('puts only the active tab in the tab order', () => {
    expect(tabIndexOf(true)).toBe(0);
    expect(tabIndexOf(false)).toBe(-1);
  });
});
