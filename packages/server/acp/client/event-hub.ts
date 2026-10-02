export interface EventHub<Event> {
  emit: (event: Event) => void;
  subscribe: (listener: (event: Event) => void) => () => void;
}

export const createEventHub = <Event>(): EventHub<Event> => {
  const listeners = new Set<(event: Event) => void>();

  const emit = (event: Event) => {
    [...listeners].forEach((listener) => listener(event));
  };

  const subscribe = (listener: (event: Event) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { emit, subscribe };
};
