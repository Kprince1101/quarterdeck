export interface Extent {
  width: number;
  height: number;
}

export interface Measurable {
  getBoundingClientRect: () => Extent;
}

export interface Focusable {
  focus: () => void;
}

export interface PointerCapturing extends EventTarget {
  setPointerCapture: (pointerId: number) => void;
}

export interface ValueTarget extends EventTarget {
  value: string;
}

export const measure = (element: HTMLElement | null): Extent | null => {
  if (element === null) return null;
  return (element as Measurable).getBoundingClientRect();
};

export const focus = (element: HTMLElement | null): void => {
  (element as Focusable | null)?.focus();
};

export const capturePointer = (
  target: EventTarget,
  pointerId: number,
): void => {
  (target as PointerCapturing).setPointerCapture(pointerId);
};

export const valueOf = (target: EventTarget): string =>
  (target as ValueTarget).value;
