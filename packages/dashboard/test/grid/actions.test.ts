import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyGridAction,
  nextItemId,
  type GridAction,
} from '../../src/grid/actions.js';
import { gridLayoutSchema, type GridLayout } from '../../src/grid/layout.js';
import { board, item, REGISTRY } from './fixtures.js';

const apply = (layout: GridLayout, action: GridAction) =>
  applyGridAction(layout, action, REGISTRY);

const placed = (layout: GridLayout | null, id: string) =>
  layout?.items.find((entry) => entry.id === id);

describe('move', () => {
  const layout = board(
    item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
    item('beta-1', { x: 4, y: 0, w: 4, h: 4 }),
  );

  it('moves an item to a free cell', () => {
    const next = apply(layout, { type: 'move', id: 'alpha-1', x: 0, y: 6 });
    expect(placed(next, 'alpha-1')).toMatchObject({ x: 0, y: 6 });
    expect(placed(layout, 'alpha-1')).toMatchObject({ x: 0, y: 0 });
  });

  it('clamps the target to the grid', () => {
    const next = apply(layout, { type: 'move', id: 'alpha-1', x: -5, y: 40 });
    expect(placed(next, 'alpha-1')).toMatchObject({ x: 0, y: 8 });
  });

  it('refuses a cell another item holds', () => {
    expect(apply(layout, { type: 'move', id: 'alpha-1', x: 2, y: 0 })).toBe(
      null,
    );
  });

  it('returns the same layout when nothing moves', () => {
    expect(apply(layout, { type: 'move', id: 'alpha-1', x: 0, y: 0 })).toBe(
      layout,
    );
  });

  it('refuses to move a hidden item', () => {
    const hidden = board(item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }, true));
    expect(apply(hidden, { type: 'move', id: 'alpha-1', x: 1, y: 1 })).toBe(
      null,
    );
  });
});

describe('nudge', () => {
  it('steps over a neighbour to the next free cell', () => {
    const layout = board(
      item('alpha-1', { x: 0, y: 0, w: 2, h: 2 }),
      item('beta-1', { x: 2, y: 0, w: 3, h: 2 }),
    );
    const next = apply(layout, { type: 'nudge', id: 'alpha-1', dx: 1, dy: 0 });
    expect(placed(next, 'alpha-1')).toMatchObject({ x: 5, y: 0 });
  });

  it('refuses at the edge of the grid', () => {
    const layout = board(item('alpha-1', { x: 0, y: 0, w: 2, h: 2 }));
    expect(apply(layout, { type: 'nudge', id: 'alpha-1', dx: -1, dy: 0 })).toBe(
      null,
    );
  });
});

describe('resize', () => {
  const layout = board(
    item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
    item('beta-1', { x: 6, y: 0, w: 4, h: 4 }),
  );

  it('grows into free cells', () => {
    const next = apply(layout, { type: 'resize', id: 'alpha-1', w: 6, h: 8 });
    expect(placed(next, 'alpha-1')).toMatchObject({ w: 6, h: 8 });
  });

  it('never shrinks below the widget minSize', () => {
    const next = apply(layout, { type: 'resize', id: 'alpha-1', w: 0, h: 1 });
    expect(placed(next, 'alpha-1')).toMatchObject({ w: 2, h: 2 });
  });

  it('refuses to grow over another item', () => {
    expect(apply(layout, { type: 'resize', id: 'alpha-1', w: 7, h: 4 })).toBe(
      null,
    );
  });

  it('stops at the edge of the grid', () => {
    const next = apply(layout, { type: 'resize', id: 'beta-1', w: 9, h: 4 });
    expect(placed(next, 'beta-1')).toMatchObject({ w: 6, h: 4 });
  });
});

describe('hide, show, duplicate, remove, add', () => {
  it('hides and shows an item in place', () => {
    const layout = board(item('alpha-1', { x: 3, y: 3, w: 4, h: 4 }));
    const hidden = apply(layout, { type: 'hide', id: 'alpha-1' });
    expect(placed(hidden, 'alpha-1')?.hidden).toBe(true);
    const shown = hidden && apply(hidden, { type: 'show', id: 'alpha-1' });
    expect(placed(shown, 'alpha-1')).toMatchObject({
      x: 3,
      y: 3,
      hidden: false,
    });
  });

  it('shows an item somewhere free when its old spot was taken', () => {
    const layout = board(
      item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }, true),
      item('beta-1', { x: 0, y: 0, w: 6, h: 6 }),
    );
    const next = apply(layout, { type: 'show', id: 'alpha-1' });
    expect(placed(next, 'alpha-1')).toMatchObject({
      x: 6,
      y: 0,
      hidden: false,
    });
  });

  it('refuses to show an item when the grid is full', () => {
    const layout = board(
      item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }, true),
      item('beta-1', { x: 0, y: 0, w: 12, h: 12 }),
    );
    expect(apply(layout, { type: 'show', id: 'alpha-1' })).toBe(null);
  });

  it('duplicates an item into the first free spot with a new id', () => {
    const layout = board(item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }));
    const next = apply(layout, { type: 'duplicate', id: 'alpha-1' });
    expect(next?.items).toEqual([
      layout.items[0],
      item('alpha-2', { x: 4, y: 0, w: 4, h: 4 }),
    ]);
  });

  it('duplicates a tabbed slot with its own copy of the tabs', () => {
    const tabbed = {
      ...item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
      tabs: ['beta'],
    };
    const next = apply(board(tabbed), { type: 'duplicate', id: 'alpha-1' });
    const copy = placed(next, 'alpha-2');
    expect(copy).toEqual({ ...tabbed, id: 'alpha-2', x: 4 });
    expect(copy?.tabs).not.toBe(tabbed.tabs);
  });

  it('removes an item', () => {
    const layout = board(item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }));
    expect(apply(layout, { type: 'remove', id: 'alpha-1' })?.items).toEqual([]);
  });

  it('adds a registered widget at its default size', () => {
    const next = apply(board(), { type: 'add', widget: 'beta' });
    expect(next?.items).toEqual([item('beta-1', { x: 0, y: 0, w: 6, h: 6 })]);
  });

  it('refuses an unknown widget or item', () => {
    expect(apply(board(), { type: 'add', widget: 'gamma' })).toBe(null);
    expect(apply(board(), { type: 'hide', id: 'gamma-1' })).toBe(null);
  });

  it('numbers new ids past the ones in use', () => {
    const layout = board(
      item('alpha-1', { x: 0, y: 0, w: 1, h: 1 }),
      item('alpha-3', { x: 1, y: 0, w: 1, h: 1 }),
    );
    expect(nextItemId(layout, 'alpha')).toBe('alpha-2');
  });
});

const ID = fc.constantFrom('alpha-1', 'alpha-2', 'beta-1', 'beta-2');
const SMALL = fc.integer({ min: -3, max: 14 });
const ACTION: fc.Arbitrary<GridAction> = fc.oneof(
  fc.record({ type: fc.constant('move' as const), id: ID, x: SMALL, y: SMALL }),
  fc.record({
    type: fc.constant('nudge' as const),
    id: ID,
    dx: fc.integer({ min: -1, max: 1 }),
    dy: fc.integer({ min: -1, max: 1 }),
  }),
  fc.record({
    type: fc.constant('resize' as const),
    id: ID,
    w: SMALL,
    h: SMALL,
  }),
  fc.record({
    type: fc.constantFrom(
      'hide' as const,
      'show' as const,
      'duplicate' as const,
      'remove' as const,
    ),
    id: ID,
  }),
  fc.record({
    type: fc.constant('add' as const),
    widget: fc.constantFrom('alpha', 'beta'),
  }),
);

describe('any sequence of actions', () => {
  it('keeps every item inside the grid, unique and without overlaps', () => {
    fc.assert(
      fc.property(fc.array(ACTION, { maxLength: 40 }), (actions) => {
        const end = actions.reduce<GridLayout>(
          (layout, action) => apply(layout, action) ?? layout,
          board(),
        );
        expect(gridLayoutSchema.safeParse(end).success).toBe(true);
        expect(JSON.parse(JSON.stringify(end))).toEqual(end);
      }),
    );
  });
});
