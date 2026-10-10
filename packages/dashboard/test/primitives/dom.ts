import type {
  Document as DomDocument,
  Event as DomEvent,
  HTMLElement as DomElement,
  KeyboardEvent as DomKeyboardEvent,
} from 'happy-dom';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export type { DomElement };

interface DomGlobals {
  document: DomDocument;
  Event: typeof DomEvent;
  KeyboardEvent: typeof DomKeyboardEvent;
}

interface KeyInit {
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export const dom = (): DomGlobals => globalThis as unknown as DomGlobals;

export interface Mounted {
  container: DomElement;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
}

export const mount = (node: ReactNode): Mounted => {
  const { document } = dom();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(
    container as unknown as Parameters<typeof createRoot>[0],
  );
  const render = (next: ReactNode): void => {
    act(() => {
      root.render(next);
    });
  };
  render(node);
  return {
    container,
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

export const find = (scope: DomElement, selector: string): DomElement => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element as DomElement;
};

export const findAll = (
  scope: DomElement,
  selector: string,
): readonly DomElement[] =>
  Array.from(scope.querySelectorAll(selector)) as DomElement[];

export const valueSetter = (field: DomElement): ((value: string) => void) => {
  let proto: object | null = Object.getPrototypeOf(field);
  while (proto !== null) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter !== undefined) return (value) => setter.call(field, value);
    proto = Object.getPrototypeOf(proto);
  }
  throw new Error('the field has no value setter');
};

export const typeInto = (field: DomElement, value: string): void => {
  act(() => {
    valueSetter(field)(value);
    field.dispatchEvent(new (dom().Event)('input', { bubbles: true }));
  });
};

export const press = async (
  target: DomElement,
  key: string,
  init: KeyInit = {},
): Promise<DomKeyboardEvent> => {
  const event = new (dom().KeyboardEvent)('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};

export const click = async (target: DomElement): Promise<void> => {
  await act(async () => {
    target.click();
  });
};

export const valueOf = (field: DomElement): string =>
  (field as unknown as { value: string }).value;

export const activeElement = (): unknown => dom().document.activeElement;
