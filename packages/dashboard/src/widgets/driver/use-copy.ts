import { useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

interface PageClipboard {
  navigator?: { clipboard?: { writeText: (text: string) => Promise<void> } };
}

const writeText = async (text: string): Promise<void> => {
  const clipboard = (globalThis as PageClipboard).navigator?.clipboard;
  if (clipboard === undefined) throw new Error('No clipboard on this page');
  await clipboard.writeText(text);
};

export interface CopyView {
  state: CopyState;
  copy: () => void;
}

export const useCopy = (text: string): CopyView => {
  const [copied, setCopied] = useState<{ text: string; state: CopyState }>({
    text,
    state: 'idle',
  });
  const copy = () => {
    writeText(text).then(
      () => {
        setCopied({ text, state: 'copied' });
      },
      () => {
        setCopied({ text, state: 'failed' });
      },
    );
  };
  if (copied.text !== text) return { state: 'idle' as const, copy };
  return { state: copied.state, copy };
};
