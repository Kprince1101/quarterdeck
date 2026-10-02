import { WidgetGrid } from '../grid/widget-grid.js';
import type { GridLayout } from '../grid/layout.js';
import type { WidgetRegistry } from './registry.js';
import { WIDGETS } from './widgets.js';

export interface WidgetMountProps {
  registry?: WidgetRegistry | undefined;
  initialLayout?: GridLayout | undefined;
}

export const WidgetMount = ({
  registry = WIDGETS,
  initialLayout,
}: WidgetMountProps) => (
  <WidgetGrid registry={registry} initialLayout={initialLayout} />
);
