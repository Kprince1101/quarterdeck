import {
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { getErrorMessage } from '../lib/errors.js';
import { applyEdit } from './chat-input-edit.js';
import { pastedText } from './chat-input-paste.js';
import {
  CHAT_INPUT_HINT,
  chatKeyEffect,
  chatMessage,
  isComposing,
  type ChatKey,
} from './chat-keys.js';
import { useChatInputAutosize } from './use-chat-input-autosize.js';

export type ChatSubmit = (message: string) => void | Promise<void>;

export interface ChatInputOptions {
  onSubmit: ChatSubmit;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

export interface ChatInputView {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  placeholder: string;
  isSending: boolean;
  isDisabled: boolean;
  isSendDisabled: boolean;
  error: string | null;
  hasError: boolean;
  handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (event: FormEvent) => void;
}

const chatKeyOf = (event: KeyboardEvent): ChatKey => ({
  key: event.key,
  shiftKey: event.shiftKey,
  isComposing: isComposing(event.nativeEvent),
});

const pasteText = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
  const text = pastedText(event.clipboardData);
  if (text === null) return;
  event.preventDefault();
  const { selectionStart, selectionEnd } = event.currentTarget;
  applyEdit(event.currentTarget, {
    start: selectionStart,
    end: selectionEnd,
    text,
  });
};

export const useChatInput = ({
  onSubmit,
  placeholder = CHAT_INPUT_HINT,
  disabled = false,
}: ChatInputOptions): ChatInputView => {
  const [draft, setDraft] = useState('');
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useChatInputAutosize(draft);
  const message = chatMessage(draft);
  const isBlocked = disabled || isSending;

  const send = async (): Promise<void> => {
    if (message === null || isBlocked) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(message);
      setDraft('');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return {
    fieldRef,
    draft,
    placeholder,
    isSending,
    isDisabled: disabled,
    isSendDisabled: isBlocked || message === null,
    error,
    hasError: error !== null,
    handleChange: ({ currentTarget }) => {
      setDraft(currentTarget.value);
    },
    handleKeyDown: (event) => {
      const field = event.currentTarget;
      const effect = chatKeyEffect(chatKeyOf(event), field);
      if (effect.kind === 'native') return;
      event.preventDefault();
      if (effect.kind === 'edit') {
        applyEdit(field, effect.edit);
        return;
      }
      void send();
    },
    handlePaste: pasteText,
    handleSubmit: (event) => {
      event.preventDefault();
      void send();
    },
  };
};
