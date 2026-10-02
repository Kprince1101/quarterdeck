import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESET,
  GRID_COLUMNS,
  GRID_ROWS,
  LAYOUT_PRESETS,
  PRESET_NAMES,
  gridLayoutSchema,
  layoutKey,
  parseGridLayout,
  presetLayout,
  readGridLayout,
  type GridItem,
} from '../../src/layouts/index.js';

const item = (id: string, rect: Partial<GridItem> = {}): GridItem => ({
  id,
  widget: 'board',
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  hidden: false,
  ...rect,
});

const layout = (...items: GridItem[]) => ({
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
  items,
});

const issues = (value: unknown): string[] => {
  const parsed = gridLayoutSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map(({ message }) => message);
};

describe('grid layout schema', () => {
  it('accepts a layout whose visible items fit without touching', () => {
    const spec = layout(
      item('a'),
      item('b', { x: 2 }),
      item('c', { x: 1, hidden: true }),
    );
    expect(parseGridLayout(spec)).toEqual(spec);
  });

  it('names every reason a layout cannot be shown', () => {
    expect(
      issues(
        layout(
          item('a'),
          item('a', { x: 4 }),
          item('b', { x: 11 }),
          item('c', { x: 1, y: 1 }),
        ),
      ),
    ).toEqual([
      'item a overlaps another item',
      'item id a is used twice',
      'item b is outside the grid',
      'item c overlaps another item',
    ]);
  });

  it('refuses unknown keys, bad widget ids and repeated tabs', () => {
    expect(
      issues(layout({ ...item('a'), config: {} } as GridItem)),
    ).toHaveLength(1);
    expect(issues(layout(item('a', { widget: 'Board' })))).toHaveLength(1);
    expect(issues(layout(item('a', { tabs: [] })))).toHaveLength(1);
    expect(issues(layout(item('a', { tabs: ['driver', 'board'] })))).toEqual([
      'a widget appears twice in one slot',
    ]);
    expect(issues(layout(item('a', { tabs: ['driver', 'notebook'] })))).toEqual(
      [],
    );
  });

  it('reads stored JSON leniently and keys layouts by content, not key order', () => {
    expect(readGridLayout({ columns: 12 })).toBeNull();
    const spec = layout(item('a'));
    const shuffled = {
      items: [
        { hidden: false, h: 2, w: 2, y: 0, x: 0, widget: 'board', id: 'a' },
      ],
      rows: GRID_ROWS,
      columns: GRID_COLUMNS,
    };
    expect(layoutKey(parseGridLayout(shuffled))).toBe(layoutKey(spec));
    expect(layoutKey(layout(item('a', { x: 1 })))).not.toBe(layoutKey(spec));
  });
});

describe('layout presets', () => {
  const visible = (name: (typeof PRESET_NAMES)[number]) =>
    LAYOUT_PRESETS[name].items.map(({ widget, tabs }) => [widget, tabs ?? []]);

  it('ships default, ops and minimal, all valid on the standard grid', () => {
    expect(PRESET_NAMES).toEqual(['default', 'ops', 'minimal']);
    expect(DEFAULT_PRESET).toBe('default');
    PRESET_NAMES.forEach((name) => {
      expect(parseGridLayout(LAYOUT_PRESETS[name])).toEqual(
        LAYOUT_PRESETS[name],
      );
    });
  });

  it('lays out the default as Board beside tabbed Planner/Driver/Notebook, Events below', () => {
    expect(visible('default')).toEqual([
      ['board', []],
      ['planner', ['driver', 'notebook']],
      ['events', []],
    ]);
    const [board, tabs, events] = LAYOUT_PRESETS.default.items;
    expect(tabs?.x).toBe((board?.x ?? 0) + (board?.w ?? 0));
    expect(tabs?.y).toBe(board?.y);
    expect(events?.y).toBe((board?.y ?? 0) + (board?.h ?? 0));
    expect(events?.w).toBe(GRID_COLUMNS);
  });

  it('keeps ops and minimal to watching and answering', () => {
    expect(visible('ops').map(([widget]) => widget)).toEqual([
      'board',
      'agents',
      'cards',
      'events',
      'usage',
    ]);
    expect(visible('minimal').map(([widget]) => widget)).toEqual([
      'board',
      'cards',
    ]);
  });

  it('hands out a copy so nobody edits the shipped preset', () => {
    const copy = presetLayout('minimal');
    expect(copy).toEqual(LAYOUT_PRESETS.minimal);
    expect(copy).not.toBe(LAYOUT_PRESETS.minimal);
    copy.items.pop();
    expect(LAYOUT_PRESETS.minimal.items).toHaveLength(2);
  });
});
