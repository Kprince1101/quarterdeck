import { useCallback, useRef, type RefCallback } from 'react';
import type { ItemKey } from './tabs.js';

export interface NewestMarkerView {
  scope: string;
  newest: ItemKey | null;
  onSeen: (key: ItemKey) => void;
}

const pageObserver = (): typeof IntersectionObserver | undefined =>
  (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;

export const useNewestMarker = ({
  scope,
  newest,
  onSeen,
}: NewestMarkerView): RefCallback<HTMLSpanElement> => {
  const latestOnSeen = useRef(onSeen);
  latestOnSeen.current = onSeen;

  return useCallback(
    (element: HTMLSpanElement | null) => {
      if (element === null || newest === null) return undefined;
      const seen = (): void => {
        latestOnSeen.current(newest);
      };
      const Observer = pageObserver();
      if (Observer === undefined) {
        seen();
        return undefined;
      }
      const observer = new Observer((entries) => {
        if (entries.at(-1)?.isIntersecting === true) seen();
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
      };
    },
    [scope, newest],
  );
};
