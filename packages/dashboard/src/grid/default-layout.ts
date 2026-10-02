import type { WidgetDefinition, WidgetRegistry } from '../widgets/registry.js';
import { fitSize, nextItemId, placeNew } from './actions.js';
import type { Bounds } from './geometry.js';
import { GRID_COLUMNS, GRID_ROWS, type GridLayout } from './layout.js';

export const DEFAULT_BOUNDS: Bounds = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
};

const addHidden = (
  layout: GridLayout,
  definition: WidgetDefinition,
): GridLayout => {
  const item = {
    id: nextItemId(layout, definition.type),
    widget: definition.type,
    x: 0,
    y: 0,
    ...fitSize(layout, definition.size),
    hidden: true,
  };
  return { ...layout, items: [...layout.items, item] };
};

const placeVisible = (
  layout: GridLayout,
  definition: WidgetDefinition,
): GridLayout | null => {
  if (definition.startHidden === true) return null;
  return placeNew(layout, { widget: definition.type }, definition.size);
};

export const defaultLayout = (
  registry: WidgetRegistry,
  bounds: Bounds = DEFAULT_BOUNDS,
): GridLayout =>
  [...registry.values()].reduce<GridLayout>(
    (layout, definition) =>
      placeVisible(layout, definition) ?? addHidden(layout, definition),
    { ...bounds, items: [] },
  );
