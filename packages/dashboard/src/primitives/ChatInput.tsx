import type { JSX } from 'react';
import { ImageStrip } from './ImageStrip.js';
import { useChatInput, type ChatInputOptions } from './use-chat-input.js';
import './chat-input.css';

export interface ChatInputProps extends ChatInputOptions {
  label: string;
}

export const ChatInput = ({
  label,
  ...options
}: ChatInputProps): JSX.Element => {
  const view = useChatInput(options);
  return (
    <form
      className="qd-chat-input"
      aria-label={label}
      aria-busy={view.isSending}
      data-dragging={view.isDragging}
      onSubmit={view.handleSubmit}
      onDragOver={view.handleDragOver}
      onDragLeave={view.handleDragLeave}
      onDrop={view.handleDrop}
    >
      <div className="qd-chat-input-compose">
        {view.hasImages && (
          <ImageStrip label={view.imagesLabel} images={view.images} />
        )}
        <textarea
          ref={view.fieldRef}
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
          onPaste={view.handlePaste}
        />
      </div>
      <div className="qd-chat-input-actions">
        <button
          type="button"
          className="qd-chat-input-attach"
          aria-label={view.attachLabel}
          title={view.attachLabel}
          disabled={view.isAttachDisabled}
          onClick={view.handleAttach}
        >
          +
        </button>
        <input
          ref={view.pickerRef}
          className="qd-chat-input-picker"
          type="file"
          accept={view.attachAccept}
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={view.handlePicked}
        />
        <button
          type="submit"
          className="qd-chat-input-send"
          disabled={view.isSendDisabled}
        >
          Send
        </button>
      </div>
      {view.hasError && (
        <p className="qd-chat-input-error" role="alert">
          {view.error}
        </p>
      )}
    </form>
  );
};
