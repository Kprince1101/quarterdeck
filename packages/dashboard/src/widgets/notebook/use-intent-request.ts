import { useCallback, useState } from 'react';
import { getErrorMessage } from '../../lib/errors.js';

export interface IntentRequest {
  isPending: boolean;
  error: string | null;
  run: (send: () => Promise<unknown>) => Promise<boolean>;
}

export const useIntentRequest = (): IntentRequest => {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (send: () => Promise<unknown>) => {
    try {
      setPending(true);
      setError(null);
      await send();
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { isPending, error, run };
};
