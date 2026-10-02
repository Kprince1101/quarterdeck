/// <reference types="vite/client" />
import {
  createRegistry,
  definitionsFrom,
  type WidgetModule,
  type WidgetRegistry,
} from './registry.js';

export const WIDGETS: WidgetRegistry = createRegistry(
  definitionsFrom(
    import.meta.glob<WidgetModule>('./**/*.widget.tsx', { eager: true }),
  ),
);
