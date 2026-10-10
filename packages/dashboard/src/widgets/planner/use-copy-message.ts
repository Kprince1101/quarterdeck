import { useEffect, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

export const COPY_LABELS: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
};

export const COPY_RESET_MS = 2000;

export interface CopyMessageView {
  label: string;
  handleCopy: () => void;
}

const copyToClipboard = async (text: string): Promise<CopyState> => {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
};

export const useCopyMessage = (text: string): CopyMessageView => {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => {
      setState('idle');
    }, COPY_RESET_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);

  return {
    label: COPY_LABELS[state],
    handleCopy: () => {
      void copyToClipboard(text).then(setState);
    },
  };
};
