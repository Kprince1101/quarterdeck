import type { Extent } from './dom.js';
import type { Bounds, Point } from './geometry.js';

export interface CellSize {
  width: number;
  height: number;
}

const ARROW_STEPS: ReadonlyMap<string, Point> = new Map([
  ['ArrowLeft', { x: -1, y: 0 }],
  ['ArrowRight', { x: 1, y: 0 }],
  ['ArrowUp', { x: 0, y: -1 }],
  ['ArrowDown', { x: 0, y: 1 }],
]);

export const ARROW_KEYS = [...ARROW_STEPS.keys()].join(' ');

export const arrowStep = (key: string): Point | undefined =>
  ARROW_STEPS.get(key);

export const cellSizeOf = (
  extent: Extent | null,
  bounds: Bounds,
): CellSize | null => {
  if (extent === null || extent.width <= 0 || extent.height <= 0) return null;
  return {
    width: extent.width / bounds.columns,
    height: extent.height / bounds.rows,
  };
};

export const cellDelta = (
  origin: Point,
  current: Point,
  cell: CellSize,
): Point => ({
  x: Math.round((current.x - origin.x) / cell.width) + 0,
  y: Math.round((current.y - origin.y) / cell.height) + 0,
});
