export interface ChatKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

export type ChatKeyAction = 'submit' | 'newline' | 'type';

export const CHAT_INPUT_HINT = 'Enter to send, Shift+Enter for a new line';

export const chatKeyAction = ({
  key,
  shiftKey,
  isComposing,
}: ChatKey): ChatKeyAction => {
  if (key !== 'Enter' || isComposing) return 'type';
  if (shiftKey) return 'newline';
  return 'submit';
};

export const chatMessage = (draft: string): string | null => {
  const message = draft.trim();
  if (message === '') return null;
  return message;
};

export const isComposing = (native: object): boolean =>
  'isComposing' in native && native.isComposing === true;
