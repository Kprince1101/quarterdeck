import {
  useCallback,
  useId,
  useMemo,
  useReducer,
  useRef,
  type ComponentType,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { WidgetProps, WidgetRegistry } from '../widgets/registry.js';
import type { GridAction } from './actions.js';
import { defaultLayout } from './default-layout.js';
import { focus, measure } from './dom.js';
import { createGridReducer, type GridState } from './grid-state.js';
import { itemLabels } from './labels.js';
import type { GridItem, GridLayout } from './layout.js';
import { cellSizeOf, type CellSize } from './steps.js';
import { useGridTray, type GridTrayView } from './use-grid-tray.js';

export interface WidgetGridProps {
  registry: WidgetRegistry;
  initialLayout?: GridLayout | undefined;
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
  Widget: ComponentType<WidgetProps>;
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
    return [
      {
        id: item.id,
        label: labels.get(item.id) ?? definition.title,
        item,
        Widget: definition.component,
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
  return useReducer(reducer, undefined, (): GridState => ({
    layout: initialLayout ?? defaultLayout(registry),
    announcement: '',
  }));
};

export const useWidgetGrid = ({
  registry,
  initialLayout,
}: WidgetGridProps): WidgetGridView => {
  const [{ layout, announcement }, dispatch] = useGridState(
    registry,
    initialLayout,
  );
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
