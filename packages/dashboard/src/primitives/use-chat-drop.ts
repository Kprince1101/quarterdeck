import { useState, type DragEvent } from 'react';
import { filesOf, hasFiles, type AttachableFile } from './chat-attachments.js';

export interface ChatDrop {
  isDragging: boolean;
  handleDragOver: (event: DragEvent) => void;
  handleDragLeave: () => void;
  handleDrop: (event: DragEvent) => void;
}

export const useChatDrop = (
  add: (files: readonly AttachableFile[]) => void,
  blocked: boolean,
): ChatDrop => {
  const [isDragging, setDragging] = useState(false);
  return {
    isDragging,
    handleDragOver: (event) => {
      if (blocked || !hasFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    },
    handleDragLeave: () => {
      setDragging(false);
    },
    handleDrop: (event) => {
      setDragging(false);
      if (blocked) return;
      const files = filesOf(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      add(files);
    },
  };
};
