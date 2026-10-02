import { WidgetGrid } from '../grid/widget-grid.js';
import type { GridLayout } from '../grid/layout.js';
import type { LayoutListener } from '../grid/use-grid-sync.js';
import type { WidgetRegistry } from './registry.js';
import { WIDGETS } from './widgets.js';

export interface WidgetMountProps {
  registry?: WidgetRegistry | undefined;
  initialLayout?: GridLayout | undefined;
  syncedLayout?: GridLayout | null | undefined;
  onLayoutChange?: LayoutListener | undefined;
}

export const WidgetMount = ({
  registry = WIDGETS,
  initialLayout,
  syncedLayout,
  onLayoutChange,
}: WidgetMountProps) => (
  <WidgetGrid
    registry={registry}
    initialLayout={initialLayout}
    syncedLayout={syncedLayout}
    onLayoutChange={onLayoutChange}
  />
);
