import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { getErrorMessage } from '../lib/errors.js';
import {
  CHAT_INPUT_HINT,
  chatKeyAction,
  chatMessage,
  isComposing,
} from './chat-keys.js';

export type ChatSubmit = (message: string) => void | Promise<void>;

export interface ChatInputOptions {
  onSubmit: ChatSubmit;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

export interface ChatInputView {
  draft: string;
  placeholder: string;
  isSending: boolean;
  isDisabled: boolean;
  isSendDisabled: boolean;
  error: string | null;
  hasError: boolean;
  handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleSubmit: (event: FormEvent) => void;
}

export const useChatInput = ({
  onSubmit,
  placeholder = CHAT_INPUT_HINT,
  disabled = false,
}: ChatInputOptions): ChatInputView => {
  const [draft, setDraft] = useState('');
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      const action = chatKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: isComposing(event.nativeEvent),
      });
      if (action !== 'submit') return;
      event.preventDefault();
      void send();
    },
    handleSubmit: (event) => {
      event.preventDefault();
      void send();
    },
  };
};
