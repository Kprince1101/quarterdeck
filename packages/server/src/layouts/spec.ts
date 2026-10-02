import { z } from 'zod';
import { inBounds, isFree } from './geometry.js';

export const GRID_COLUMNS = 12;
export const GRID_ROWS = 12;
export const MAX_GRID_SPAN = 48;
export const MAX_LAYOUT_ITEMS = 200;
export const MAX_ITEM_ID_LENGTH = 100;
export const WIDGET_TYPE = /^[a-z][a-z0-9-]*$/;

const cell = z.number().int().nonnegative();
const span = z.number().int().positive();
const gridSpan = span.max(MAX_GRID_SPAN);

export const widgetTypeSchema = z.string().regex(WIDGET_TYPE);

export const gridItemSchema = z
  .strictObject({
    id: z.string().min(1).max(MAX_ITEM_ID_LENGTH),
    widget: widgetTypeSchema,
    x: cell,
    y: cell,
    w: span,
    h: span,
    hidden: z.boolean(),
    tabs: z.array(widgetTypeSchema).min(1).optional(),
  })
  .refine(
    ({ widget, tabs = [] }) =>
      new Set([widget, ...tabs]).size === tabs.length + 1,
    { message: 'a widget appears twice in one slot', path: ['tabs'] },
  );

export const gridLayoutSchema = z
  .strictObject({
    columns: gridSpan,
    rows: gridSpan,
    items: z.array(gridItemSchema).max(MAX_LAYOUT_ITEMS),
  })
  .superRefine((layout, context) => {
    const ids = new Set<string>();
    layout.items.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'id'],
          message: `item id ${item.id} is used twice`,
        });
      }
      ids.add(item.id);
      if (!inBounds(layout, item)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: `item ${item.id} is outside the grid`,
        });
        return;
      }
      if (!item.hidden && !isFree(layout, item, item.id)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: `item ${item.id} overlaps another item`,
        });
      }
    });
  });

export type GridItem = z.infer<typeof gridItemSchema>;
export type GridLayout = z.infer<typeof gridLayoutSchema>;

export const parseGridLayout = (value: unknown): GridLayout =>
  gridLayoutSchema.parse(value);

export const readGridLayout = (value: unknown): GridLayout | null => {
  const parsed = gridLayoutSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
};

export const layoutKey = (layout: GridLayout): string =>
  JSON.stringify(parseGridLayout(layout));
