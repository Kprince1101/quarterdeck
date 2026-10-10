import { useCallback, useState } from 'react';
import { getErrorMessage } from '../lib/errors.js';

export interface KeepAwakeSend {
  isSending: boolean;
  error: string | null;
  send: (work: () => Promise<unknown>) => void;
}

export const useKeepAwakeSend = (): KeepAwakeSend => {
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((work: () => Promise<unknown>) => {
    const run = async (): Promise<void> => {
      try {
        setSending(true);
        setError(null);
        await work();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setSending(false);
      }
    };
    void run();
  }, []);

  return { isSending, error, send };
};
