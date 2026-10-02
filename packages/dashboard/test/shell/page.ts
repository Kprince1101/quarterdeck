import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export interface PageElement {
  textContent: string | null;
  innerHTML: string;
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => PageElement | null;
  querySelectorAll: (selector: string) => ArrayLike<PageElement>;
}

interface Page {
  document: {
    body: PageElement;
    createElement: (tag: string) => PageElement;
  };
}

export const page = (): Page['document'] =>
  (globalThis as unknown as Page).document;

export const all = (
  scope: PageElement,
  selector: string,
): readonly PageElement[] => Array.from(scope.querySelectorAll(selector));

export const textOf = (scope: PageElement, selector: string): string => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element.textContent ?? '';
};

export interface Rendered {
  container: PageElement;
  unmount: () => void;
}

const run = (work: () => void): void => {
  const { IS_REACT_ACT_ENVIRONMENT } = globalThis as {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  if (IS_REACT_ACT_ENVIRONMENT === true) act(work);
  else work();
};

export const render = (node: ReactNode): Rendered => {
  const container = page().createElement('div');
  const root = createRoot(
    container as unknown as Parameters<typeof createRoot>[0],
  );
  run(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      run(() => {
        root.unmount();
      });
    },
  };
};
