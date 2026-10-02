import { describe, expect, it } from 'vitest';
import { defaultLayout } from '../../src/grid/default-layout.js';
import { findSpot, isFree, overlaps } from '../../src/grid/geometry.js';
import { itemLabels } from '../../src/grid/labels.js';
import { parseGridLayout } from '../../src/grid/layout.js';
import { cellDelta, cellSizeOf } from '../../src/grid/steps.js';
import { createRegistry, defineWidget } from '../../src/widgets/registry.js';
import { ALPHA, BETA, board, item, REGISTRY } from './fixtures.js';

describe('geometry', () => {
  it('treats touching edges as not overlapping', () => {
    const a = { x: 0, y: 0, w: 2, h: 2 };
    expect(overlaps(a, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
    expect(overlaps(a, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
  });

  it('ignores hidden items and the item being placed', () => {
    const layout = board(
      item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
      item('beta-1', { x: 4, y: 0, w: 4, h: 4 }, true),
    );
    const rect = { x: 4, y: 0, w: 4, h: 4 };
    expect(isFree(layout, rect)).toBe(true);
    expect(isFree(layout, { ...rect, x: 2 })).toBe(false);
    expect(isFree(layout, { ...rect, x: 2 }, 'alpha-1')).toBe(true);
  });

  it('finds the first free spot row by row', () => {
    const layout = board(item('alpha-1', { x: 0, y: 0, w: 10, h: 2 }));
    expect(findSpot(layout, { w: 2, h: 2 })).toEqual({ x: 10, y: 0 });
    expect(findSpot(layout, { w: 3, h: 2 })).toEqual({ x: 0, y: 2 });
    expect(findSpot(layout, { w: 13, h: 1 })).toBe(null);
  });
});

describe('pointer steps', () => {
  it('turns a pointer offset into whole cells', () => {
    const cell = cellSizeOf({ width: 1200, height: 600 }, board());
    expect(cell).toEqual({ width: 100, height: 50 });
    expect(
      cellDelta(
        { x: 10, y: 10 },
        { x: 260, y: -40 },
        { width: 100, height: 50 },
      ),
    ).toEqual({
      x: 3,
      y: -1,
    });
    expect(
      cellDelta({ x: 0, y: 0 }, { x: -20, y: 0 }, { width: 100, height: 50 }),
    ).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('has no cell size before the grid is laid out', () => {
    expect(cellSizeOf({ width: 0, height: 0 }, board())).toBe(null);
    expect(cellSizeOf(null, board())).toBe(null);
  });
});

describe('layout JSON', () => {
  it('round-trips a valid layout', () => {
    const layout = board(item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }));
    expect(parseGridLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

  it.each([
    ['an item off the grid', [item('alpha-1', { x: 10, y: 0, w: 4, h: 4 })]],
    [
      'overlapping items',
      [
        item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
        item('beta-1', { x: 2, y: 2, w: 4, h: 4 }),
      ],
    ],
    [
      'a repeated id',
      [
        item('alpha-1', { x: 0, y: 0, w: 2, h: 2 }),
        item('alpha-1', { x: 4, y: 4, w: 2, h: 2 }, true),
      ],
    ],
  ])('rejects %s', (_, items) => {
    expect(() => parseGridLayout(board(...items))).toThrow();
  });

  it('lets hidden items share space', () => {
    const items = [
      item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
      item('beta-1', { x: 0, y: 0, w: 4, h: 4 }, true),
    ];
    expect(parseGridLayout(board(...items)).items).toEqual(items);
  });
});

describe('default layout', () => {
  it('places every registered widget once, in registry order', () => {
    expect(defaultLayout(REGISTRY)).toEqual(
      board(
        item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
        item('beta-1', { x: 4, y: 0, w: 6, h: 6 }),
      ),
    );
  });

  it('hides what does not fit', () => {
    const wide = defineWidget({
      ...BETA,
      type: 'wide',
      size: { w: 12, h: 12 },
    });
    const layout = defaultLayout(createRegistry([wide, ALPHA]));
    expect(layout.items).toEqual([
      item('wide-1', { x: 0, y: 0, w: 12, h: 12 }),
      item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }, true),
    ]);
  });
});

describe('labels', () => {
  it('numbers copies of the same widget', () => {
    const layout = board(
      item('alpha-1', { x: 0, y: 0, w: 2, h: 2 }),
      item('beta-1', { x: 2, y: 0, w: 2, h: 2 }),
      item('alpha-4', { x: 4, y: 0, w: 2, h: 2 }),
    );
    expect([...itemLabels(layout, REGISTRY).values()]).toEqual([
      'Alpha',
      'Beta',
      'Alpha 2',
    ]);
  });
});
