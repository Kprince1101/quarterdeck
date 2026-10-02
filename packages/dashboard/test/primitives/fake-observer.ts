import { act } from 'react';

interface Intersection {
  isIntersecting: boolean;
}

type ObserverCallback = (entries: readonly Intersection[]) => void;

export class FakeObserver {
  static made: FakeObserver[] = [];

  readonly targets: object[] = [];
  disconnected = false;
  readonly #callback: ObserverCallback;

  constructor(callback: ObserverCallback) {
    this.#callback = callback;
    FakeObserver.made.push(this);
  }

  static watching(): FakeObserver[] {
    return FakeObserver.made.filter(({ disconnected }) => !disconnected);
  }

  static only(): FakeObserver {
    const [only, ...rest] = FakeObserver.watching();
    if (only === undefined || rest.length > 0) {
      throw new Error(`expected one live observer, saw ${rest.length + 1}`);
    }
    return only;
  }

  observe(target: object): void {
    this.targets.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  report(isIntersecting: boolean): void {
    act(() => {
      this.#callback([{ isIntersecting }]);
    });
  }
}

const page = globalThis as { IntersectionObserver?: unknown };

export const installObserver = (observer: unknown): (() => void) => {
  const original = page.IntersectionObserver;
  page.IntersectionObserver = observer;
  FakeObserver.made = [];
  return () => {
    page.IntersectionObserver = original;
  };
};
