import type { WidgetRegistry } from '../widgets/registry.js';
import type { GridLayout } from './layout.js';

export const titleOf = (registry: WidgetRegistry, widget: string): string =>
  registry.get(widget)?.title ?? widget;

export const itemLabels = (
  layout: GridLayout,
  registry: WidgetRegistry,
): ReadonlyMap<string, string> => {
  const seen = new Map<string, number>();
  return new Map(
    layout.items.map((item) => {
      const count = (seen.get(item.widget) ?? 0) + 1;
      seen.set(item.widget, count);
      const title = titleOf(registry, item.widget);
      if (count === 1) return [item.id, title];
      return [item.id, `${title} ${count}`];
    }),
  );
};
