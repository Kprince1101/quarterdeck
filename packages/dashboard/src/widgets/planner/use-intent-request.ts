import { useRef, useState } from 'react';
import { getErrorMessage } from '../../lib/errors.js';

export interface IntentRequest {
  isBusy: boolean;
  error: string | null;
  hasError: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
}

export const useIntentRequest = (): IntentRequest => {
  const busy = useRef(false);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      busy.current = false;
      setBusy(false);
    }
  };

  return { isBusy, error, hasError: error !== null, run };
};
