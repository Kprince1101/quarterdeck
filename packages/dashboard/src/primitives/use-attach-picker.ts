import { useRef, type ChangeEvent, type RefObject } from 'react';
import { filesOf, type AttachableFile } from './chat-attachments.js';

export interface AttachPicker {
  pickerRef: RefObject<HTMLInputElement | null>;
  handleAttach: () => void;
  handlePicked: (event: ChangeEvent<HTMLInputElement>) => void;
}

export const useAttachPicker = (
  add: (files: readonly AttachableFile[]) => void,
): AttachPicker => {
  const pickerRef = useRef<HTMLInputElement>(null);
  return {
    pickerRef,
    handleAttach: () => {
      pickerRef.current?.click();
    },
    handlePicked: ({ currentTarget }) => {
      add(filesOf(currentTarget));
      currentTarget.value = '';
    },
  };
};
