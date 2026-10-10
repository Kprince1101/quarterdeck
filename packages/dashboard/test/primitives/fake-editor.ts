import { act } from 'react';
import { dom, valueSetter, type DomElement } from './dom.js';

interface Snapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface FakeEditor {
  commands: string[];
  undo: () => void;
  uninstall: () => void;
}

const textField = (element: unknown): HTMLTextAreaElement | null => {
  if (!(element instanceof Object) || !('tagName' in element)) return null;
  if (element.tagName !== 'TEXTAREA') return null;
  return element as HTMLTextAreaElement;
};

const snapshot = ({
  value,
  selectionStart,
  selectionEnd,
}: HTMLTextAreaElement): Snapshot => ({ value, selectionStart, selectionEnd });

const write = (field: HTMLTextAreaElement, next: Snapshot): void => {
  valueSetter(field as unknown as DomElement)(next.value);
  field.setSelectionRange(next.selectionStart, next.selectionEnd);
  field.dispatchEvent(
    new (dom().Event)('input', { bubbles: true }) as unknown as Event,
  );
};

const TEXT_COMMANDS = new Set(['insertText', 'delete']);

export const installFakeEditor = (): FakeEditor => {
  const { document } = dom();
  const history: Snapshot[] = [];
  const commands: string[] = [];

  const replaceSelection = (field: HTMLTextAreaElement, text: string) => {
    const before = snapshot(field);
    history.push(before);
    const caret = before.selectionStart + text.length;
    write(field, {
      value: `${before.value.slice(0, before.selectionStart)}${text}${before.value.slice(before.selectionEnd)}`,
      selectionStart: caret,
      selectionEnd: caret,
    });
  };

  const execCommand = (command: string, _showUi = false, text = '') => {
    const field = textField(document.activeElement);
    if (field === null) return false;
    commands.push(command);
    if (TEXT_COMMANDS.has(command)) {
      replaceSelection(field, text);
      return true;
    }
    if (command !== 'undo') return false;
    const previous = history.pop();
    if (previous === undefined) return false;
    write(field, previous);
    return true;
  };

  Object.assign(document, { execCommand });
  return {
    commands,
    undo: () => {
      act(() => {
        execCommand('undo');
      });
    },
    uninstall: () => {
      Reflect.deleteProperty(document, 'execCommand');
    },
  };
};

export const placeCaret = (
  field: DomElement,
  start: number,
  end: number = start,
): void => {
  (field as unknown as HTMLTextAreaElement).setSelectionRange(start, end);
};
