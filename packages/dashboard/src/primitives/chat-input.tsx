import { useChatInput, type ChatInputOptions } from './use-chat-input.js';
import './chat-input.css';

export interface ChatInputProps extends ChatInputOptions {
  label: string;
}

export const ChatInput = ({ label, ...options }: ChatInputProps) => {
  const view = useChatInput(options);
  return (
    <form
      className="qd-chat-input"
      aria-label={label}
      aria-busy={view.isSending}
      onSubmit={view.handleSubmit}
    >
      <textarea
        className="qd-chat-input-field"
        aria-label={label}
        aria-invalid={view.hasError}
        placeholder={view.placeholder}
        rows={1}
        value={view.draft}
        readOnly={view.isSending}
        disabled={view.isDisabled}
        onChange={view.handleChange}
        onKeyDown={view.handleKeyDown}
      />
      <button
        type="submit"
        className="qd-chat-input-send"
        disabled={view.isSendDisabled}
      >
        Send
      </button>
      {view.hasError && (
        <p className="qd-chat-input-error" role="alert">
          {view.error}
        </p>
      )}
    </form>
  );
};
