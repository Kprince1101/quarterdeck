import { all, type PageElement } from './page.js';

export type Press = (element: PageElement) => void;

const labelled = (container: PageElement, label: string): PageElement => {
  const element = container.querySelector(`[aria-label="${label}"]`);
  if (element === null) throw new Error(`nothing is labelled ${label}`);
  return element;
};

export const showOnly = (
  container: PageElement,
  labels: readonly string[],
  press: Press,
): void => {
  all(container, '[data-grid-item] [aria-label^="Hide "]').forEach(press);
  labels.forEach((label) => {
    press(labelled(container, `Show ${label}`));
  });
};
