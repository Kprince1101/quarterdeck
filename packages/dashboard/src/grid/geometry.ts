export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect extends Point, Size {}

export interface Bounds {
  columns: number;
  rows: number;
}

export interface Placed extends Rect {
  id: string;
  hidden: boolean;
}

export interface Board extends Bounds {
  items: readonly Placed[];
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const inBounds = (bounds: Bounds, rect: Rect): boolean =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.w >= 1 &&
  rect.h >= 1 &&
  rect.x + rect.w <= bounds.columns &&
  rect.y + rect.h <= bounds.rows;

export const isFree = (board: Board, rect: Rect, ignoreId?: string): boolean =>
  inBounds(board, rect) &&
  !board.items.some(
    (item) => !item.hidden && item.id !== ignoreId && overlaps(item, rect),
  );

const positions = (bounds: Bounds, size: Size): Point[] =>
  Array.from({ length: Math.max(bounds.rows - size.h + 1, 0) }, (_, y) =>
    Array.from(
      { length: Math.max(bounds.columns - size.w + 1, 0) },
      (_, x) => ({
        x,
        y,
      }),
    ),
  ).flat();

export const findSpot = (board: Board, size: Size): Point | null =>
  positions(board, size).find((point) =>
    isFree(board, { ...point, w: size.w, h: size.h }),
  ) ?? null;
