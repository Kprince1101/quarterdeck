import {
  minSizeOf,
  type WidgetRegistry,
  type WidgetSize,
} from '../widgets/registry.js';
import { clamp, findSpot, isFree } from './geometry.js';
import type { GridItem, GridLayout } from './layout.js';

interface ItemAction {
  id: string;
}

export interface MoveAction extends ItemAction {
  type: 'move';
  x: number;
  y: number;
}

export interface NudgeAction extends ItemAction {
  type: 'nudge';
  dx: number;
  dy: number;
}

export interface ResizeAction extends ItemAction {
  type: 'resize';
  w: number;
  h: number;
}

export interface ItemCommand extends ItemAction {
  type: 'hide' | 'show' | 'duplicate' | 'remove';
}

export interface AddAction {
  type: 'add';
  widget: string;
}

export type GridAction =
  MoveAction | NudgeAction | ResizeAction | ItemCommand | AddAction;

const ANYWHERE: WidgetSize = { w: 1, h: 1 };
const PLACED_ONLY = new Set<GridAction['type']>(['move', 'nudge', 'resize']);

const minSizeFor = (registry: WidgetRegistry, widget: string): WidgetSize => {
  const definition = registry.get(widget);
  if (definition === undefined) return ANYWHERE;
  return minSizeOf(definition);
};

export const findItem = (
  layout: GridLayout,
  id: string,
): GridItem | undefined => layout.items.find((item) => item.id === id);

const replace = (layout: GridLayout, next: GridItem): GridLayout => ({
  ...layout,
  items: layout.items.with(
    layout.items.findIndex((item) => item.id === next.id),
    next,
  ),
});

export const nextItemId = (layout: GridLayout, widget: string): string => {
  const taken = new Set(layout.items.map(({ id }) => id));
  let n = 1;
  while (taken.has(`${widget}-${n}`)) n += 1;
  return `${widget}-${n}`;
};

export const fitSize = (layout: GridLayout, size: WidgetSize): WidgetSize => ({
  w: clamp(size.w, 1, layout.columns),
  h: clamp(size.h, 1, layout.rows),
});

export type Slot = Pick<GridItem, 'widget' | 'tabs'>;

const slotOf = ({ widget, tabs }: Slot): Slot => {
  if (tabs === undefined) return { widget };
  return { widget, tabs: [...tabs] };
};

export const placeNew = (
  layout: GridLayout,
  slot: Slot,
  wanted: WidgetSize,
): GridLayout | null => {
  const size = fitSize(layout, wanted);
  const spot = findSpot(layout, size);
  if (spot === null) return null;
  const item = {
    id: nextItemId(layout, slot.widget),
    ...slotOf(slot),
    ...spot,
    ...size,
    hidden: false,
  };
  return { ...layout, items: [...layout.items, item] };
};

const moveTo = (
  layout: GridLayout,
  item: GridItem,
  x: number,
  y: number,
): GridLayout | null => {
  const next = {
    ...item,
    x: clamp(x, 0, layout.columns - item.w),
    y: clamp(y, 0, layout.rows - item.h),
  };
  if (next.x === item.x && next.y === item.y) return layout;
  if (!isFree(layout, next, item.id)) return null;
  return replace(layout, next);
};

const nudge = (
  layout: GridLayout,
  item: GridItem,
  { dx, dy }: NudgeAction,
): GridLayout | null => {
  if (dx === 0 && dy === 0) return layout;
  const reach = Math.max(layout.columns, layout.rows);
  const steps = Array.from({ length: reach }, (_, index) => index + 1);
  const free = steps
    .map((step) => ({ ...item, x: item.x + dx * step, y: item.y + dy * step }))
    .find((next) => isFree(layout, next, item.id));
  if (free === undefined) return null;
  return replace(layout, free);
};

const resize = (
  layout: GridLayout,
  item: GridItem,
  { w, h }: ResizeAction,
  registry: WidgetRegistry,
): GridLayout | null => {
  const min = minSizeFor(registry, item.widget);
  const next = {
    ...item,
    w: clamp(w, min.w, layout.columns - item.x),
    h: clamp(h, min.h, layout.rows - item.y),
  };
  if (next.w === item.w && next.h === item.h) return layout;
  if (!isFree(layout, next, item.id)) return null;
  return replace(layout, next);
};

const show = (layout: GridLayout, item: GridItem): GridLayout | null => {
  if (!item.hidden) return layout;
  if (isFree(layout, item, item.id)) {
    return replace(layout, { ...item, hidden: false });
  }
  const spot = findSpot(layout, item);
  if (spot === null) return null;
  return replace(layout, { ...item, ...spot, hidden: false });
};

const hide = (layout: GridLayout, item: GridItem): GridLayout => {
  if (item.hidden) return layout;
  return replace(layout, { ...item, hidden: true });
};

const remove = (layout: GridLayout, item: GridItem): GridLayout => ({
  ...layout,
  items: layout.items.filter(({ id }) => id !== item.id),
});

const applyToItem = (
  layout: GridLayout,
  item: GridItem,
  action: Exclude<GridAction, AddAction>,
  registry: WidgetRegistry,
): GridLayout | null => {
  switch (action.type) {
    case 'move':
      return moveTo(layout, item, action.x, action.y);
    case 'nudge':
      return nudge(layout, item, action);
    case 'resize':
      return resize(layout, item, action, registry);
    case 'hide':
      return hide(layout, item);
    case 'show':
      return show(layout, item);
    case 'duplicate':
      return placeNew(layout, item, item);
    case 'remove':
      return remove(layout, item);
  }
};

export const applyGridAction = (
  layout: GridLayout,
  action: GridAction,
  registry: WidgetRegistry,
): GridLayout | null => {
  if (action.type === 'add') {
    const definition = registry.get(action.widget);
    if (definition === undefined) return null;
    return placeNew(layout, { widget: action.widget }, definition.size);
  }
  const item = findItem(layout, action.id);
  if (item === undefined) return null;
  if (item.hidden && PLACED_ONLY.has(action.type)) return null;
  return applyToItem(layout, item, action, registry);
};
