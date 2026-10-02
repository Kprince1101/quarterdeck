import type { WidgetRegistry } from '../widgets/registry.js';
import { applyGridAction, findItem, type GridAction } from './actions.js';
import { itemLabels, titleOf } from './labels.js';
import type { GridItem, GridLayout } from './layout.js';

export interface GridState {
  layout: GridLayout;
  announcement: string;
}

type ActionType = GridAction['type'];

const moved = (item: GridItem, label: string): string =>
  `${label} moved to column ${item.x + 1}, row ${item.y + 1}.`;

const DONE: Record<ActionType, (item: GridItem, label: string) => string> = {
  move: moved,
  nudge: moved,
  resize: (item, label) => `${label} resized to ${item.w} by ${item.h}.`,
  hide: (_, label) => `${label} hidden.`,
  show: (_, label) => `${label} shown.`,
  duplicate: (_, label) => `${label} added as a copy.`,
  remove: (_, label) => `${label} removed.`,
  add: (_, label) => `${label} added.`,
};

const REFUSED: Record<ActionType, (label: string) => string> = {
  move: (label) => `${label} cannot move there.`,
  nudge: (label) => `${label} cannot move further that way.`,
  resize: (label) => `${label} cannot take that size there.`,
  hide: (label) => `${label} is not on the grid.`,
  show: (label) => `No room to show ${label}.`,
  duplicate: (label) => `No room for another ${label}.`,
  remove: (label) => `${label} is not on the grid.`,
  add: (label) => `No room for another ${label}.`,
};

const refusedLabel = (
  layout: GridLayout,
  action: GridAction,
  registry: WidgetRegistry,
): string => {
  if (action.type === 'add') return titleOf(registry, action.widget);
  return itemLabels(layout, registry).get(action.id) ?? action.id;
};

const subjectOf = (
  action: GridAction,
  before: GridLayout,
  after: GridLayout,
): { item: GridItem | undefined; layout: GridLayout } => {
  if (action.type === 'add' || action.type === 'duplicate') {
    return { item: after.items.at(-1), layout: after };
  }
  const placed = findItem(after, action.id);
  if (placed !== undefined) return { item: placed, layout: after };
  return { item: findItem(before, action.id), layout: before };
};

export const announce = (
  action: GridAction,
  before: GridLayout,
  after: GridLayout | null,
  registry: WidgetRegistry,
): string => {
  if (after === null) {
    return REFUSED[action.type](refusedLabel(before, action, registry));
  }
  const { item, layout } = subjectOf(action, before, after);
  if (item === undefined) return '';
  const label = itemLabels(layout, registry).get(item.id) ?? item.id;
  return DONE[action.type](item, label);
};

export const createGridReducer =
  (registry: WidgetRegistry) =>
  (state: GridState, action: GridAction): GridState => {
    const next = applyGridAction(state.layout, action, registry);
    if (next === state.layout) return state;
    const announcement = announce(action, state.layout, next, registry);
    if (next === null && announcement === state.announcement) return state;
    return { layout: next ?? state.layout, announcement };
  };
