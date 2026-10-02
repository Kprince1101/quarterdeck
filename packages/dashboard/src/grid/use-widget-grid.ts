import {
  useCallback,
  useId,
  useMemo,
  useReducer,
  useRef,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { WidgetRegistry } from '../widgets/registry.js';
import type { GridAction } from './actions.js';
import { defaultLayout } from './default-layout.js';
import { focus, measure } from './dom.js';
import { createGridReducer, initialGridState } from './grid-state.js';
import { itemLabels } from './labels.js';
import type { GridItem, GridLayout } from './layout.js';
import { panesOf, type PaneView } from './panes.js';
import { cellSizeOf, type CellSize } from './steps.js';
import { useGridSync, type LayoutListener } from './use-grid-sync.js';
import { useGridTray, type GridTrayView } from './use-grid-tray.js';

export interface WidgetGridProps {
  registry: WidgetRegistry;
  initialLayout?: GridLayout | undefined;
  syncedLayout?: GridLayout | null | undefined;
  onLayoutChange?: LayoutListener | undefined;
}

export interface GridControls {
  dispatch: (action: GridAction) => void;
  cellSize: () => CellSize | null;
  focusTray: () => void;
  moveHelpId: string;
  resizeHelpId: string;
}

export interface CellView {
  id: string;
  label: string;
  item: GridItem;
  panes: PaneView[];
  stacked: boolean;
  style: CSSProperties;
}

export interface WidgetGridView {
  gridRef: RefObject<HTMLDivElement | null>;
  gridStyle: CSSProperties;
  cells: CellView[];
  controls: GridControls;
  tray: GridTrayView;
  announcement: string;
}

const spanOf = (start: number, span: number): string =>
  `${start + 1} / span ${span}`;

const cellViews = (
  layout: GridLayout,
  registry: WidgetRegistry,
): CellView[] => {
  const labels = itemLabels(layout, registry);
  return layout.items.flatMap((item) => {
    const definition = registry.get(item.widget);
    if (item.hidden || definition === undefined) return [];
    const panes = panesOf(item, registry);
    return [
      {
        id: item.id,
        label: labels.get(item.id) ?? definition.title,
        item,
        panes,
        stacked: panes.length > 1,
        style: {
          gridColumn: spanOf(item.x, item.w),
          gridRow: spanOf(item.y, item.h),
        },
      },
    ];
  });
};

const useGridState = (
  registry: WidgetRegistry,
  initialLayout: GridLayout | undefined,
) => {
  const reducer = useMemo(() => createGridReducer(registry), [registry]);
  return useReducer(reducer, undefined, () =>
    initialGridState(initialLayout ?? defaultLayout(registry)),
  );
};

export const useWidgetGrid = ({
  registry,
  initialLayout,
  syncedLayout,
  onLayoutChange,
}: WidgetGridProps): WidgetGridView => {
  const [state, dispatch] = useGridState(registry, initialLayout);
  useGridSync({ state, dispatch, syncedLayout, onLayoutChange });
  const { layout, announcement } = state;
  const gridRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const helpId = useId();
  const { columns, rows } = layout;
  const cellSize = useCallback(
    (): CellSize | null =>
      cellSizeOf(measure(gridRef.current), { columns, rows }),
    [columns, rows],
  );
  const focusTray = useCallback(() => {
    focus(trayRef.current);
  }, []);
  const controls = useMemo(
    () => ({
      dispatch,
      cellSize,
      focusTray,
      moveHelpId: `${helpId}-move`,
      resizeHelpId: `${helpId}-resize`,
    }),
    [dispatch, cellSize, focusTray, helpId],
  );
  const cells = useMemo(() => cellViews(layout, registry), [layout, registry]);
  const tray = useGridTray({
    registry,
    layout,
    dispatch,
    trayRef,
    focusTray,
  });
  return {
    gridRef,
    gridStyle: {
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    },
    cells,
    controls,
    tray,
    announcement,
  };
};
