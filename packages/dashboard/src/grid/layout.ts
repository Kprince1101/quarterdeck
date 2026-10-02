import { z } from 'zod';
import { inBounds, isFree } from './geometry.js';

export const GRID_COLUMNS = 12;
export const GRID_ROWS = 12;

const cell = z.number().int().nonnegative();
const span = z.number().int().positive();

export const gridItemSchema = z.object({
  id: z.string().min(1),
  widget: z.string().min(1),
  x: cell,
  y: cell,
  w: span,
  h: span,
  hidden: z.boolean(),
});

export const gridLayoutSchema = z
  .object({
    columns: span,
    rows: span,
    items: z.array(gridItemSchema),
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
