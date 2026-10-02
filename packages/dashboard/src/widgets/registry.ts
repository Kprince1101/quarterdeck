import type { ComponentType } from 'react';

export interface WidgetSize {
  w: number;
  h: number;
}

export interface WidgetProps {
  instanceId: string;
}

export interface WidgetDefinition {
  type: string;
  title: string;
  component: ComponentType<WidgetProps>;
  size: WidgetSize;
  minSize?: WidgetSize;
}

export type WidgetRegistry = ReadonlyMap<string, WidgetDefinition>;

export interface WidgetModule {
  default?: unknown;
}

const WIDGET_TYPE = /^[a-z][a-z0-9-]*$/;
const SMALLEST: WidgetSize = { w: 1, h: 1 };

export const defineWidget = (definition: WidgetDefinition): WidgetDefinition =>
  definition;

export const minSizeOf = (definition: WidgetDefinition): WidgetSize =>
  definition.minSize ?? SMALLEST;

const isDefinition = (value: unknown): value is WidgetDefinition =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  'component' in value;

const checkSize = (definition: WidgetDefinition): void => {
  const min = minSizeOf(definition);
  if (min.w < 1 || min.h < 1) {
    throw new Error(`widget ${definition.type} has a minSize under 1`);
  }
  if (definition.size.w < min.w || definition.size.h < min.h) {
    throw new Error(`widget ${definition.type} is smaller than its minSize`);
  }
};

export const createRegistry = (
  definitions: readonly WidgetDefinition[],
): WidgetRegistry => {
  const registry = new Map<string, WidgetDefinition>();
  definitions.forEach((definition) => {
    if (!WIDGET_TYPE.test(definition.type)) {
      throw new Error(`widget type ${definition.type} is not kebab-case`);
    }
    if (registry.has(definition.type)) {
      throw new Error(`widget ${definition.type} is registered twice`);
    }
    checkSize(definition);
    registry.set(definition.type, definition);
  });
  return registry;
};

export const definitionsFrom = (
  modules: Record<string, WidgetModule>,
): WidgetDefinition[] =>
  Object.keys(modules)
    .toSorted()
    .map((path) => {
      const definition = modules[path]?.default;
      if (!isDefinition(definition)) {
        throw new Error(`${path} must export default defineWidget({...})`);
      }
      return definition;
    });
