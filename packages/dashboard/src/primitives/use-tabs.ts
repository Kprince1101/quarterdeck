import { useId, type KeyboardEvent, type RefCallback } from 'react';
import {
  panelDomId,
  tabDomId,
  tabIndexOf,
  type ItemKey,
  type TabSpec,
} from './tabs.js';
import { useActiveTab } from './use-active-tab.js';
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
  panelId: string;
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
  activeNewest: ItemKey | null;
  tabs: TabView[];
  panel: TabPanelView;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleNewestSeen: (key: ItemKey) => void;
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

  return {
    activeId: active.activeId,
    activeNewest: tabs.find(({ id }) => id === activeId)?.newest ?? null,
    tabs: tabs.map((tab) => {
      const isActive = tab.id === activeId;
      return {
        id: tab.id,
        label: tab.label,
        domId: tabDomId(prefix, tab.id),
        panelId: panelDomId(prefix, tab.id),
        isActive,
        isUnread: unread.isUnread(tab),
        tabIndex: tabIndexOf(isActive),
        ref: active.registerTab(tab.id),
        handleSelect: () => {
          active.select(tab.id);
        },
      };
    }),
    panel: {
      id: panelDomId(prefix, activeId),
      labelledBy: tabDomId(prefix, activeId),
    },
    handleKeyDown: active.handleKeyDown,
    handleNewestSeen: (key) => {
      unread.markSeen(activeId, key);
    },
  };
};
