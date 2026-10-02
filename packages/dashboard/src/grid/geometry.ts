import {
  isFree,
  type Board,
  type Bounds,
  type Point,
  type Size,
} from '@quarterdeck/server/layouts';

export {
  inBounds,
  isFree,
  overlaps,
  type Board,
  type Bounds,
  type Placed,
  type Point,
  type Rect,
  type Size,
} from '@quarterdeck/server/layouts';

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

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
