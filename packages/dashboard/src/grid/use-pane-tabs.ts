import { useMemo, type KeyboardEvent } from 'react';
import {
  useTabs,
  type TabPanelView,
  type TabSpec,
  type TabView,
} from '../primitives/index.js';
import type { PaneView } from './panes.js';

export interface PaneTabsView {
  tabs: TabView[];
  panel: TabPanelView;
  activePanes: PaneView[];
  handleKeyDown: (event: KeyboardEvent) => void;
}

const tabSpecsOf = (panes: readonly PaneView[]): TabSpec[] =>
  panes.map(({ type, title }) => ({ id: type, label: title, newest: null }));

export const usePaneTabs = (panes: readonly PaneView[]): PaneTabsView => {
  const specs = useMemo(() => tabSpecsOf(panes), [panes]);
  const { tabs, panel, activeId, handleKeyDown } = useTabs({ tabs: specs });
  return {
    tabs,
    panel,
    activePanes: panes.filter(({ type }) => type === activeId),
    handleKeyDown,
  };
};
