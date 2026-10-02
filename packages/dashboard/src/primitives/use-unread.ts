import { useCallback, useState } from 'react';
import {
  isUnread,
  markSeenKey,
  seenKeysOf,
  type ItemKey,
  type SeenKeys,
  type TabSpec,
} from './tabs.js';

export interface UnreadTabs {
  isUnread: (tab: TabSpec) => boolean;
  markSeen: (id: string, key: ItemKey) => void;
}

export const useUnread = (
  tabs: readonly TabSpec[],
  ready: boolean,
): UnreadTabs => {
  const [seen, setSeen] = useState<SeenKeys | null>(null);
  if (ready && seen === null) setSeen(seenKeysOf(tabs));

  const markSeen = useCallback((id: string, key: ItemKey) => {
    setSeen((current) => markSeenKey(current, id, key));
  }, []);

  return { isUnread: (tab) => isUnread(tab, seen), markSeen };
};
