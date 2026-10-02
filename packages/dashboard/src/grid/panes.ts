import type { ComponentType } from 'react';
import type { WidgetProps, WidgetRegistry } from '../widgets/registry.js';
import type { GridItem } from './layout.js';

export interface PaneView {
  type: string;
  title: string;
  instanceId: string;
  Widget: ComponentType<WidgetProps>;
}

const paneId = (itemId: string, type: string, index: number): string => {
  if (index === 0) return itemId;
  return `${itemId}:${type}`;
};

export const slotWidgets = (item: GridItem): string[] => [
  item.widget,
  ...(item.tabs ?? []),
];

export const hasPanes = (item: GridItem, registry: WidgetRegistry): boolean =>
  slotWidgets(item).some((type) => registry.has(type));

export const slotTitle = (item: GridItem, registry: WidgetRegistry): string => {
  const shown = slotWidgets(item).find((type) => registry.has(type));
  return registry.get(shown ?? item.widget)?.title ?? item.widget;
};

export const panesOf = (item: GridItem, registry: WidgetRegistry): PaneView[] =>
  slotWidgets(item).flatMap((type, index) => {
    const definition = registry.get(type);
    if (definition === undefined) return [];
    return [
      {
        type,
        title: definition.title,
        instanceId: paneId(item.id, type, index),
        Widget: definition.component,
      },
    ];
  });
