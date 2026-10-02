import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ALL,
  JUST_NOW,
  eventFeed,
  kindOptions,
  projectOptions,
  relativeTime,
} from '../../../src/widgets/events/event-feed.js';
import {
  DECK,
  NOW,
  PROJECTS,
  SITE,
  STRAY,
  ago,
  streamEvent,
} from './fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const EVENTS = [
  streamEvent(1, 'project.created', DECK, ago(2 * DAY)),
  streamEvent(2, 'notebook.added', SITE, ago(3 * HOUR)),
  streamEvent(3, 'notebook.added', DECK, ago(5 * MINUTE)),
  streamEvent(4, 'card.raised', STRAY, ago(1000)),
];

const feed = (project = ALL, kind = ALL) =>
  eventFeed({
    events: EVENTS,
    projects: PROJECTS,
    filters: { project, kind },
    now: NOW,
  });

describe('relativeTime', () => {
  it('says how long ago in whole minutes, hours and days', () => {
    expect(relativeTime(ago(MINUTE), NOW)).toBe('1m ago');
    expect(relativeTime(ago(59 * MINUTE + 59_999), NOW)).toBe('59m ago');
    expect(relativeTime(ago(HOUR), NOW)).toBe('1h ago');
    expect(relativeTime(ago(23 * HOUR + 59 * MINUTE), NOW)).toBe('23h ago');
    expect(relativeTime(ago(DAY), NOW)).toBe('1d ago');
    expect(relativeTime(ago(40 * DAY), NOW)).toBe('40d ago');
  });

  it('clamps anything under a minute, and anything ahead of now, to just now', () => {
    expect(relativeTime(ago(0), NOW)).toBe(JUST_NOW);
    expect(relativeTime(ago(59_999), NOW)).toBe(JUST_NOW);
    expect(relativeTime(ago(-5000), NOW)).toBe(JUST_NOW);
    expect(relativeTime(ago(-2 * DAY), NOW)).toBe(JUST_NOW);
    expect(relativeTime('not a time', NOW)).toBe(JUST_NOW);
  });

  it('never reads as negative or in the future', () => {
    fc.assert(
      fc.property(fc.integer({ min: -400 * DAY, max: 400 * DAY }), (ms) => {
        const text = relativeTime(ago(ms), NOW);
        expect(text).toMatch(/^(just now|[1-9]\d*[mhd] ago)$/);
        if (ms < MINUTE) expect(text).toBe(JUST_NOW);
      }),
    );
  });
});

describe('eventFeed', () => {
  it('lists every event newest first with its project name and age', () => {
    const { rows, isEmpty, isFilteredOut } = feed();
    expect(rows).toEqual([
      {
        id: 4,
        kind: 'card.raised',
        project: STRAY,
        createdAt: ago(1000),
        age: JUST_NOW,
      },
      {
        id: 3,
        kind: 'notebook.added',
        project: 'Deck',
        createdAt: ago(5 * MINUTE),
        age: '5m ago',
      },
      {
        id: 2,
        kind: 'notebook.added',
        project: 'Site',
        createdAt: ago(3 * HOUR),
        age: '3h ago',
      },
      {
        id: 1,
        kind: 'project.created',
        project: 'Deck',
        createdAt: ago(2 * DAY),
        age: '2d ago',
      },
    ]);
    expect(isEmpty).toBe(false);
    expect(isFilteredOut).toBe(false);
  });

  it('orders by event id even when the input is not', () => {
    const { rows } = eventFeed({
      events: EVENTS.toSorted((a, b) => a.kind.localeCompare(b.kind)),
      projects: PROJECTS,
      filters: { project: ALL, kind: ALL },
      now: NOW,
    });
    expect(rows.map(({ id }) => id)).toEqual([4, 3, 2, 1]);
  });

  it('filters by project', () => {
    expect(feed(DECK).rows.map(({ id }) => id)).toEqual([3, 1]);
    expect(feed(STRAY).rows.map(({ id }) => id)).toEqual([4]);
  });

  it('filters by kind', () => {
    expect(feed(ALL, 'notebook.added').rows.map(({ id }) => id)).toEqual([
      3, 2,
    ]);
  });

  it('filters by project and kind together', () => {
    expect(feed(SITE, 'notebook.added').rows.map(({ id }) => id)).toEqual([2]);
    const none = feed(SITE, 'project.created');
    expect(none.rows).toEqual([]);
    expect(none.isFilteredOut).toBe(true);
    expect(none.isEmpty).toBe(false);
  });

  it('is empty, not filtered out, before any event arrives', () => {
    const { rows, isEmpty, isFilteredOut } = eventFeed({
      events: [],
      projects: PROJECTS,
      filters: { project: DECK, kind: 'card.raised' },
      now: NOW,
    });
    expect(rows).toEqual([]);
    expect(isEmpty).toBe(true);
    expect(isFilteredOut).toBe(false);
  });

  it('agrees with a plain filter for any events and filters', () => {
    const projectIds = [DECK, SITE, STRAY];
    const kinds = ['a.one', 'a.two', 'b.one'];
    const arbitraryEvents = fc
      .uniqueArray(
        fc.record({
          id: fc.integer({ min: 1, max: 10_000 }),
          project: fc.constantFrom(...projectIds),
          kind: fc.constantFrom(...kinds),
        }),
        { selector: ({ id }) => id, maxLength: 30 },
      )
      .map((specs) =>
        specs.map(({ id, project, kind }) =>
          streamEvent(id, kind, project, ago(id * MINUTE)),
        ),
      );
    fc.assert(
      fc.property(
        arbitraryEvents,
        fc.constantFrom(ALL, ...projectIds),
        fc.constantFrom(ALL, ...kinds),
        (events, project, kind) => {
          const { rows } = eventFeed({
            events,
            projects: PROJECTS,
            filters: { project, kind },
            now: NOW,
          });
          const expected = events
            .filter(
              (e) =>
                (project === ALL || e.projectId === project) &&
                (kind === ALL || e.kind === kind),
            )
            .map(({ id }) => id)
            .toSorted((a, b) => b - a);
          expect(rows.map(({ id }) => id)).toEqual(expected);
        },
      ),
    );
  });
});

describe('filter options', () => {
  it('offers every known project by name, plus projects only seen in events', () => {
    expect(projectOptions(EVENTS, PROJECTS, ALL)).toEqual([
      { value: ALL, label: 'All projects' },
      { value: STRAY, label: STRAY },
      { value: DECK, label: 'Deck' },
      { value: SITE, label: 'Site' },
    ]);
  });

  it('offers each kind once, sorted', () => {
    expect(kindOptions(EVENTS, ALL)).toEqual([
      { value: ALL, label: 'All kinds' },
      { value: 'card.raised', label: 'card.raised' },
      { value: 'notebook.added', label: 'notebook.added' },
      { value: 'project.created', label: 'project.created' },
    ]);
  });

  it('keeps the chosen value on offer after its events are gone', () => {
    expect(kindOptions([], 'card.raised')).toEqual([
      { value: ALL, label: 'All kinds' },
      { value: 'card.raised', label: 'card.raised' },
    ]);
    expect(projectOptions([], [], SITE)).toEqual([
      { value: ALL, label: 'All projects' },
      { value: SITE, label: SITE },
    ]);
  });
});
