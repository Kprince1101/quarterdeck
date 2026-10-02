import { useRef, useState, type KeyboardEvent, type RefCallback } from 'react';
import { resolveActiveTab, tabAfterKey, type TabSpec } from './tabs.js';

export interface ActiveTab {
  activeId: string | null;
  select: (id: string) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  registerTab: (id: string) => RefCallback<HTMLButtonElement>;
}

export const useActiveTab = (
  tabs: readonly TabSpec[],
  initial: string | null,
): ActiveTab => {
  const [selected, setSelected] = useState(initial);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const activeId = resolveActiveTab(tabs, selected);

  return {
    activeId,
    select: setSelected,
    handleKeyDown: (event) => {
      const next = tabAfterKey(tabs, activeId, event.key);
      if (next === null) return;
      event.preventDefault();
      setSelected(next);
      elements.current.get(next)?.focus();
    },
    registerTab: (id) => (element) => {
      if (element === null) return undefined;
      elements.current.set(id, element);
      return () => {
        elements.current.delete(id);
      };
    },
  };
};
