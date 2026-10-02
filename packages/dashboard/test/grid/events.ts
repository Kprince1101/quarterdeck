import type {
  HTMLElement as HappyElement,
  HTMLSelectElement as HappySelect,
  Window,
} from 'happy-dom';
import { act } from 'react';
import type { PageElement } from '../shell/page.js';

const win = (): Window => (globalThis as unknown as { window: Window }).window;

const happy = (element: PageElement): HappyElement =>
  element as unknown as HappyElement;

export const press = (element: PageElement, key: string): void => {
  act(() => {
    happy(element).dispatchEvent(
      new (win().KeyboardEvent)('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

export const click = (element: PageElement): void => {
  act(() => {
    happy(element).click();
  });
};

export const point = (
  element: PageElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
): void => {
  act(() => {
    happy(element).dispatchEvent(
      new (win().PointerEvent)(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId: 1,
        button: 0,
      }),
    );
  });
};

export const choose = (select: PageElement, value: string): void => {
  act(() => {
    const element = select as unknown as HappySelect;
    element.value = value;
    element.dispatchEvent(new (win().Event)('change', { bubbles: true }));
  });
};

export const stubSize = (
  element: PageElement,
  width: number,
  height: number,
): void => {
  const target = happy(element);
  const rect = { x: 0, y: 0, top: 0, left: 0, width, height };
  target.getBoundingClientRect = () =>
    rect as unknown as ReturnType<HappyElement['getBoundingClientRect']>;
};
