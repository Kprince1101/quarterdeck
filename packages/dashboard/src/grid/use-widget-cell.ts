import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { GridItem } from './layout.js';
import { arrowStep, ARROW_KEYS } from './steps.js';
import {
  usePointerDrag,
  type DragHandlers,
  type ToAction,
} from './use-pointer-drag.js';
import type { CellView, GridControls } from './use-widget-grid.js';

export interface WidgetCellProps {
  cell: CellView;
  controls: GridControls;
}

type KeyHandler = (event: ReactKeyboardEvent<HTMLElement>) => void;

export interface WidgetCellView {
  moveLabel: string;
  resizeLabel: string;
  duplicateLabel: string;
  hideLabel: string;
  arrowKeys: string;
  moveHelpId: string;
  resizeHelpId: string;
  moveDrag: DragHandlers;
  resizeDrag: DragHandlers;
  handleMoveKey: KeyHandler;
  handleResizeKey: KeyHandler;
  handleDuplicate: () => void;
  handleHide: () => void;
}

const nudge: ToAction = ({ id }, delta) => ({
  type: 'nudge',
  id,
  dx: delta.x,
  dy: delta.y,
});

const moveBy: ToAction = ({ id, x, y }, delta) => ({
  type: 'move',
  id,
  x: x + delta.x,
  y: y + delta.y,
});

const resizeBy: ToAction = ({ id, w, h }, delta) => ({
  type: 'resize',
  id,
  w: w + delta.x,
  h: h + delta.y,
});

const keyHandler =
  (
    item: GridItem,
    { dispatch }: GridControls,
    toAction: ToAction,
  ): KeyHandler =>
  (event) => {
    const step = arrowStep(event.key);
    if (step === undefined) return;
    event.preventDefault();
    dispatch(toAction(item, step));
  };

export const useWidgetCell = ({
  cell,
  controls,
}: WidgetCellProps): WidgetCellView => {
  const { item, label } = cell;
  const { dispatch, cellSize, focusTray } = controls;
  const moveDrag = usePointerDrag({
    item,
    dispatch,
    cellSize,
    toAction: moveBy,
  });
  const resizeDrag = usePointerDrag({
    item,
    dispatch,
    cellSize,
    toAction: resizeBy,
  });
  return {
    moveLabel: `Move ${label}`,
    resizeLabel: `Resize ${label}`,
    duplicateLabel: `Duplicate ${label}`,
    hideLabel: `Hide ${label}`,
    arrowKeys: ARROW_KEYS,
    moveHelpId: controls.moveHelpId,
    resizeHelpId: controls.resizeHelpId,
    moveDrag,
    resizeDrag,
    handleMoveKey: keyHandler(item, controls, nudge),
    handleResizeKey: keyHandler(item, controls, resizeBy),
    handleDuplicate: () => dispatch({ type: 'duplicate', id: item.id }),
    handleHide: () => {
      dispatch({ type: 'hide', id: item.id });
      focusTray();
    },
  };
};
