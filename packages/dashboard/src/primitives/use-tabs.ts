import { useId, type KeyboardEvent, type RefCallback } from 'react';
import {
  controlsOf,
  panelDomId,
  tabDomId,
  tabIndexOf,
  type TabSpec,
} from './tabs.js';
import { useActiveTab } from './use-active-tab.js';
import type { NewestMarkerView } from './use-newest-marker.js';
import { useUnread } from './use-unread.js';

export interface TabsOptions {
  tabs: readonly TabSpec[];
  initial?: string | undefined;
  ready?: boolean | undefined;
}

export interface TabView {
  id: string;
  label: string;
  domId: string;
  controls: string | undefined;
  isActive: boolean;
  isUnread: boolean;
  tabIndex: number;
  ref: RefCallback<HTMLButtonElement>;
  handleSelect: () => void;
}

export interface TabPanelView {
  id: string;
  labelledBy: string;
}

export interface TabsView {
  activeId: string | null;
  tabs: TabView[];
  panel: TabPanelView;
  marker: NewestMarkerView;
  handleKeyDown: (event: KeyboardEvent) => void;
}

export const useTabs = ({
  tabs,
  initial,
  ready = true,
}: TabsOptions): TabsView => {
  const prefix = useId();
  const active = useActiveTab(tabs, initial ?? null);
  const unread = useUnread(tabs, ready);
  const activeId = active.activeId ?? '';
  const panelId = panelDomId(prefix, activeId);

  return {
    activeId: active.activeId,
    tabs: tabs.map((tab) => {
      const isActive = tab.id === activeId;
      return {
        id: tab.id,
        label: tab.label,
        domId: tabDomId(prefix, tab.id),
        controls: controlsOf(isActive, panelId),
        isActive,
        isUnread: unread.isUnread(tab),
        tabIndex: tabIndexOf(isActive),
        ref: active.registerTab(tab.id),
        handleSelect: () => {
          active.select(tab.id);
        },
      };
    }),
    panel: { id: panelId, labelledBy: tabDomId(prefix, activeId) },
    marker: {
      scope: activeId,
      newest: tabs.find(({ id }) => id === activeId)?.newest ?? null,
      onSeen: (key) => {
        unread.markSeen(activeId, key);
      },
    },
    handleKeyDown: active.handleKeyDown,
  };
};
