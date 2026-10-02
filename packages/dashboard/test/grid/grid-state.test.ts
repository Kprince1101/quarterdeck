import { describe, expect, it } from 'vitest';
import type { GridAction } from '../../src/grid/actions.js';
import {
  LAYOUT_LOADED,
  createGridReducer,
  initialGridState,
  type GridState,
} from '../../src/grid/grid-state.js';
import { board, item, REGISTRY } from './fixtures.js';

const reduce = createGridReducer(REGISTRY);

const start: GridState = initialGridState(
  board(
    item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }),
    item('beta-1', { x: 4, y: 0, w: 4, h: 4 }),
  ),
);

const said = (action: GridAction, state: GridState = start): string =>
  reduce(state, action).announcement;

describe('grid announcements', () => {
  it.each<[GridAction, string]>([
    [
      { type: 'move', id: 'alpha-1', x: 0, y: 5 },
      'Alpha moved to column 1, row 6.',
    ],
    [
      { type: 'nudge', id: 'beta-1', dx: 0, dy: 1 },
      'Beta moved to column 5, row 2.',
    ],
    [{ type: 'resize', id: 'alpha-1', w: 3, h: 6 }, 'Alpha resized to 3 by 6.'],
    [{ type: 'hide', id: 'beta-1' }, 'Beta hidden.'],
    [{ type: 'duplicate', id: 'alpha-1' }, 'Alpha 2 added as a copy.'],
    [{ type: 'remove', id: 'beta-1' }, 'Beta removed.'],
    [{ type: 'add', widget: 'beta' }, 'Beta 2 added.'],
    [{ type: 'move', id: 'alpha-1', x: 4, y: 0 }, 'Alpha cannot move there.'],
    [
      { type: 'resize', id: 'alpha-1', w: 6, h: 4 },
      'Alpha cannot take that size there.',
    ],
    [{ type: 'add', widget: 'gamma' }, 'No room for another gamma.'],
  ])('%j says %s', (action, message) => {
    expect(said(action)).toBe(message);
  });

  it('keeps the layout when an action is refused', () => {
    const next = reduce(start, { type: 'move', id: 'alpha-1', x: 4, y: 0 });
    expect(next.layout).toBe(start.layout);
  });

  it('keeps the same state for a no-op or a repeated refusal', () => {
    expect(reduce(start, { type: 'move', id: 'alpha-1', x: 0, y: 0 })).toBe(
      start,
    );
    const refused = reduce(start, { type: 'move', id: 'alpha-1', x: 4, y: 0 });
    expect(reduce(refused, { type: 'move', id: 'alpha-1', x: 5, y: 0 })).toBe(
      refused,
    );
  });

  it('says when there is no room to show a widget', () => {
    const full = initialGridState(
      board(
        item('alpha-1', { x: 0, y: 0, w: 4, h: 4 }, true),
        item('beta-1', { x: 0, y: 0, w: 12, h: 12 }),
      ),
    );
    expect(said({ type: 'show', id: 'alpha-1' }, full)).toBe(
      'No room to show Alpha.',
    );
  });
});

describe('grid origin', () => {
  it('marks a change from a control as an edit and a refusal as nothing new', () => {
    const moved = reduce(start, { type: 'move', id: 'alpha-1', x: 0, y: 5 });
    expect(moved.origin).toBe('edit');
    const refused = reduce(start, { type: 'move', id: 'alpha-1', x: 4, y: 0 });
    expect(refused.origin).toBe('initial');
    expect(refused.layout).toBe(start.layout);
  });

  it('loads a different layout as a load and ignores the same one', () => {
    const other = board(item('beta-1', { x: 0, y: 0, w: 6, h: 6 }));
    const loaded = reduce(start, { type: 'load', layout: other });
    expect(loaded).toEqual({
      layout: other,
      announcement: LAYOUT_LOADED,
      origin: 'load',
    });
    const reordered = {
      items: start.layout.items.map(({ hidden, h, w, y, x, widget, id }) => ({
        hidden,
        h,
        w,
        y,
        x,
        widget,
        id,
      })),
      rows: start.layout.rows,
      columns: start.layout.columns,
    };
    expect(reduce(start, { type: 'load', layout: reordered })).toBe(start);
  });
});
