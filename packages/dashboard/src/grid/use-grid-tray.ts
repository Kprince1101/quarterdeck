import { useMemo, useState, type ChangeEvent, type RefObject } from 'react';
import type { WidgetRegistry } from '../widgets/registry.js';
import type { GridAction } from './actions.js';
import { valueOf } from './dom.js';
import { itemLabels } from './labels.js';
import type { GridLayout } from './layout.js';
import { hasPanes } from './panes.js';

export interface WidgetOption {
  type: string;
  title: string;
}

export interface HiddenWidget {
  id: string;
  label: string;
  showLabel: string;
  removeLabel: string;
  onShow: () => void;
  onRemove: () => void;
}

export interface GridTrayView {
  trayRef: RefObject<HTMLElement | null>;
  options: WidgetOption[];
  chosen: string;
  canAdd: boolean;
  hidden: HiddenWidget[];
  hasHidden: boolean;
  handleChoose: (event: ChangeEvent<HTMLSelectElement>) => void;
  handleAdd: () => void;
}

export interface GridTraySources {
  registry: WidgetRegistry;
  layout: GridLayout;
  dispatch: (action: GridAction) => void;
  trayRef: RefObject<HTMLElement | null>;
  focusTray: () => void;
}

const hiddenWidgets = (
  layout: GridLayout,
  registry: WidgetRegistry,
  dispatch: (action: GridAction) => void,
  focusTray: () => void,
): HiddenWidget[] => {
  const labels = itemLabels(layout, registry);
  const run = (action: GridAction) => () => {
    dispatch(action);
    focusTray();
  };
  return layout.items
    .filter((item) => item.hidden && hasPanes(item, registry))
    .map(({ id }) => {
      const label = labels.get(id) ?? id;
      return {
        id,
        label,
        showLabel: `Show ${label}`,
        removeLabel: `Remove ${label}`,
        onShow: run({ type: 'show', id }),
        onRemove: run({ type: 'remove', id }),
      };
    });
};

export const useGridTray = ({
  registry,
  layout,
  dispatch,
  trayRef,
  focusTray,
}: GridTraySources): GridTrayView => {
  const options = useMemo(
    () => [...registry.values()].map(({ type, title }) => ({ type, title })),
    [registry],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = picked ?? options[0]?.type ?? '';
  const hidden = useMemo(
    () => hiddenWidgets(layout, registry, dispatch, focusTray),
    [layout, registry, dispatch, focusTray],
  );
  return {
    trayRef,
    options,
    chosen,
    canAdd: options.length > 0,
    hidden,
    hasHidden: hidden.length > 0,
    handleChoose: (event) => setPicked(valueOf(event.currentTarget)),
    handleAdd: () => dispatch({ type: 'add', widget: chosen }),
  };
};
