import type { GridItem, GridLayout } from '../../src/grid/layout.js';
import {
  createRegistry,
  defineWidget,
  type WidgetProps,
} from '../../src/widgets/registry.js';

const Probe = ({ instanceId }: WidgetProps) => (
  <p data-probe={instanceId}>{instanceId}</p>
);

export const ALPHA = defineWidget({
  type: 'alpha',
  title: 'Alpha',
  component: Probe,
  size: { w: 4, h: 4 },
  minSize: { w: 2, h: 2 },
});

export const BETA = defineWidget({
  type: 'beta',
  title: 'Beta',
  component: Probe,
  size: { w: 6, h: 6 },
});

export const REGISTRY = createRegistry([ALPHA, BETA]);

export const item = (
  id: string,
  rect: Pick<GridItem, 'x' | 'y' | 'w' | 'h'>,
  hidden = false,
): GridItem => ({ id, widget: id.split('-')[0] ?? id, ...rect, hidden });

export const board = (...items: GridItem[]): GridLayout => ({
  columns: 12,
  rows: 12,
  items,
});
