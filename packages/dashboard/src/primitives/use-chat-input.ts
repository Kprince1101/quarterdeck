import {
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { AttachmentUpload } from '@quarterdeck/server/intents';
import { getErrorMessage } from '../lib/errors.js';
import { ATTACH_ACCEPT, ATTACH_LABEL, filesOf } from './chat-attachments.js';
import { applyEdit } from './chat-input-edit.js';
import { pastedText } from './chat-input-paste.js';
import {
  CHAT_INPUT_HINT,
  chatKeyEffect,
  chatMessage,
  isComposing,
  type ChatKey,
} from './chat-keys.js';
import { useAttachPicker, type AttachPicker } from './use-attach-picker.js';
import { useChatAttachments } from './use-chat-attachments.js';
import { useChatDrop, type ChatDrop } from './use-chat-drop.js';
import { useChatInputAutosize } from './use-chat-input-autosize.js';
import type { ImageThumb } from './use-image-strip.js';

export type ChatSubmit = (
  message: string,
  attachments: AttachmentUpload[],
) => void | Promise<void>;

export interface ChatInputOptions {
  onSubmit: ChatSubmit;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

export interface ChatInputView extends ChatDrop, AttachPicker {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  placeholder: string;
  isSending: boolean;
  isDisabled: boolean;
  isSendDisabled: boolean;
  isAttachDisabled: boolean;
  attachLabel: string;
  attachAccept: string;
  images: ImageThumb[];
  hasImages: boolean;
  imagesLabel: string;
  error: string | null;
  hasError: boolean;
  handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (event: FormEvent) => void;
}

export const ATTACHED_IMAGES_LABEL = 'Attached images';

const chatKeyOf = (event: KeyboardEvent): ChatKey => ({
  key: event.key,
  shiftKey: event.shiftKey,
  isComposing: isComposing(event.nativeEvent),
});

const pasteText = (event: ClipboardEvent<HTMLTextAreaElement>): boolean => {
  const text = pastedText(event.clipboardData);
  if (text === null) return false;
  event.preventDefault();
  const { selectionStart, selectionEnd } = event.currentTarget;
  applyEdit(event.currentTarget, {
    start: selectionStart,
    end: selectionEnd,
    text,
  });
  return true;
};

export const useChatInput = ({
  onSubmit,
  placeholder = CHAT_INPUT_HINT,
  disabled = false,
}: ChatInputOptions): ChatInputView => {
  const [draft, setDraft] = useState('');
  const [isSending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const fieldRef = useChatInputAutosize(draft);
  const attachments = useChatAttachments();
  const isBlocked = disabled || isSending;
  const drop = useChatDrop(attachments.add, isBlocked);
  const picker = useAttachPicker(attachments.add);
  const message = chatMessage(draft);
  const hasContent = message !== null || attachments.hasImages;
  const error = sendError ?? attachments.refusal;

  const send = async (): Promise<void> => {
    if (!hasContent || isBlocked || attachments.isReading) return;
    setSending(true);
    setSendError(null);
    try {
      await onSubmit(message ?? '', attachments.uploads);
      setDraft('');
      attachments.clear();
    } catch (err) {
      setSendError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return {
    ...drop,
    ...picker,
    fieldRef,
    draft,
    placeholder,
    isSending,
    isDisabled: disabled,
    isSendDisabled: isBlocked || attachments.isReading || !hasContent,
    isAttachDisabled: isBlocked,
    attachLabel: ATTACH_LABEL,
    attachAccept: ATTACH_ACCEPT,
    images: attachments.thumbs,
    hasImages: attachments.hasImages,
    imagesLabel: ATTACHED_IMAGES_LABEL,
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
    handlePaste: (event) => {
      const files = filesOf(event.clipboardData);
      if (files.length > 0 && !isBlocked) attachments.add(files);
      if (pasteText(event)) return;
      if (files.length > 0) event.preventDefault();
    },
    handleSubmit: (event) => {
      event.preventDefault();
      void send();
    },
  };
};
