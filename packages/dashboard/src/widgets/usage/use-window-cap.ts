import { useEffect, useState } from 'react';
import { useDeck } from '../../deck/deck.js';
import { getErrorMessage } from '../../lib/errors.js';
import { useNow } from '../../lib/use-now.js';
import { windowCapOf } from './usage-model.js';

export const CAP_REFRESH_MS = 60_000;

export interface WindowCap {
  cap: number | null;
  capLoaded: boolean;
  capError: string | null;
}

const LOADING: WindowCap = { cap: null, capLoaded: false, capError: null };

export const useWindowCap = (): WindowCap => {
  const { rules } = useDeck();
  const tick = useNow(CAP_REFRESH_MS);
  const [state, setState] = useState<WindowCap>(LOADING);

  useEffect(() => {
    let live = true;
    rules(null)
      .then(windowCapOf)
      .then(
        (cap) => {
          if (live) setState({ cap, capLoaded: true, capError: null });
        },
        (err: unknown) => {
          if (!live) return;
          setState((last) => ({ ...last, capError: getErrorMessage(err) }));
        },
      );
    return () => {
      live = false;
    };
  }, [rules, tick]);

  return state;
};
