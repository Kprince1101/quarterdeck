import { useEffect, useRef } from 'react';
import type { GridState, GridStateAction } from './grid-state.js';
import type { GridLayout } from './layout.js';

export type LayoutListener = (layout: GridLayout) => void;

export interface GridSyncSources {
  state: GridState;
  dispatch: (action: GridStateAction) => void;
  syncedLayout: GridLayout | null | undefined;
  onLayoutChange: LayoutListener | undefined;
}

export const useGridSync = ({
  state,
  dispatch,
  syncedLayout,
  onLayoutChange,
}: GridSyncSources): void => {
  useEffect(() => {
    if (syncedLayout === null || syncedLayout === undefined) return;
    dispatch({ type: 'load', layout: syncedLayout });
  }, [dispatch, syncedLayout]);

  const notified = useRef(state.layout);
  useEffect(() => {
    if (state.origin !== 'edit' || notified.current === state.layout) return;
    notified.current = state.layout;
    onLayoutChange?.(state.layout);
  }, [state.layout, state.origin, onLayoutChange]);
};
