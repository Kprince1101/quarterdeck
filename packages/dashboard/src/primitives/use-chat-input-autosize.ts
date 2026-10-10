import { useLayoutEffect, useRef, type RefObject } from 'react';

const pixels = (value: string): number => Number.parseFloat(value) || 0;

export const fitToContent = (field: HTMLTextAreaElement): void => {
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  const border =
    pixels(style?.borderTopWidth ?? '') +
    pixels(style?.borderBottomWidth ?? '');
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + border}px`;
};

export const useChatInputAutosize = (
  draft: string,
): RefObject<HTMLTextAreaElement | null> => {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (fieldRef.current === null) return;
    fitToContent(fieldRef.current);
  }, [draft]);
  return fieldRef;
};
