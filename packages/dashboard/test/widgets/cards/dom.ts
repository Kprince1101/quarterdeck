import type {
  HTMLElement as HappyElement,
  HTMLInputElement as HappyInput,
  HTMLTextAreaElement as HappyTextArea,
  Window,
} from 'happy-dom';
import { act } from 'react';
import type { PageElement } from '../../shell/page.js';

const win = (): Window => (globalThis as unknown as { window: Window }).window;

export const find = (scope: PageElement, selector: string): PageElement => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
};

export const buttonNamed = (scope: PageElement, label: string): PageElement => {
  const button = Array.from(scope.querySelectorAll('button')).find(
    ({ textContent }) => textContent === label,
  );
  if (button === undefined) throw new Error(`no ${label} button`);
  return button;
};

export const clickButton = async (
  scope: PageElement,
  label: string,
): Promise<void> => {
  const button = buttonNamed(scope, label);
  await act(async () => {
    (button as unknown as HappyElement).click();
  });
};

export const typeAndSend = async (
  scope: PageElement,
  text: string,
): Promise<void> => {
  const field = find(scope, 'textarea') as unknown as HappyTextArea;
  const setValue = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field),
    'value',
  )?.set;
  if (setValue === undefined) throw new Error('the field has no value setter');
  act(() => {
    setValue.call(field, text);
    field.dispatchEvent(new (win().Event)('input', { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(
      new (win().KeyboardEvent)('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

export const check = (box: PageElement): void => {
  act(() => {
    (box as unknown as HappyInput).click();
  });
};

export const isChecked = (box: PageElement): boolean =>
  (box as unknown as HappyInput).checked;

export const isDisabled = (element: PageElement): boolean =>
  (element as unknown as HappyInput).disabled;
