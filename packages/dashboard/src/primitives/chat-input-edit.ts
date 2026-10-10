import type { TextEdit } from './chat-input-lists.js';

const insertNatively = (field: HTMLTextAreaElement, text: string): boolean => {
  const document = field.ownerDocument;
  if (typeof document.execCommand !== 'function') return false;
  if (text === '') return document.execCommand('delete');
  return document.execCommand('insertText', false, text);
};

const insertDirectly = (field: HTMLTextAreaElement, edit: TextEdit): void => {
  field.setRangeText(edit.text, edit.start, edit.end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

export const applyEdit = (field: HTMLTextAreaElement, edit: TextEdit): void => {
  if (field.readOnly || field.disabled) return;
  field.focus();
  field.setSelectionRange(edit.start, edit.end);
  if (edit.start === edit.end && edit.text === '') return;
  if (insertNatively(field, edit.text)) return;
  insertDirectly(field, edit);
};
