import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { GridAction } from './actions.js';
import { capturePointer } from './dom.js';
import type { Point } from './geometry.js';
import type { GridItem } from './layout.js';
import { cellDelta, type CellSize } from './steps.js';

export type PointerHandler = (event: ReactPointerEvent<HTMLElement>) => void;
export type ToAction = (item: GridItem, delta: Point) => GridAction;

export interface DragSources {
  item: GridItem;
  dispatch: (action: GridAction) => void;
  cellSize: () => CellSize | null;
  toAction: ToAction;
}

export interface DragHandlers {
  onPointerDown: PointerHandler;
  onPointerMove: PointerHandler;
  onPointerUp: PointerHandler;
  onPointerCancel: PointerHandler;
}

interface Drag {
  origin: Point;
  cell: CellSize;
  item: GridItem;
}

const pointOf = (event: ReactPointerEvent<HTMLElement>): Point => ({
  x: event.clientX,
  y: event.clientY,
});

export const usePointerDrag = ({
  item,
  dispatch,
  cellSize,
  toAction,
}: DragSources): DragHandlers => {
  const drag = useRef<Drag | null>(null);
  const end = () => {
    drag.current = null;
  };
  return {
    onPointerDown: (event) => {
      const cell = cellSize();
      if (event.button !== 0 || cell === null) return;
      event.preventDefault();
      capturePointer(event.currentTarget, event.pointerId);
      drag.current = { origin: pointOf(event), cell, item };
    },
    onPointerMove: (event) => {
      const start = drag.current;
      if (start === null) return;
      const delta = cellDelta(start.origin, pointOf(event), start.cell);
      dispatch(toAction(start.item, delta));
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
};
