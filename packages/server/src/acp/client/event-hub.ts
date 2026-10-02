import { getErrorMessage } from '../../lib/errors.js';

export type ListenerErrorReporter<Event> = (err: unknown, event: Event) => void;

export interface EventHub<Event> {
  emit: (event: Event) => void;
  subscribe: (listener: (event: Event) => void) => () => void;
}

export const logListenerError = (err: unknown): void => {
  console.error(`ACP client event listener failed: ${getErrorMessage(err)}`);
};

export const createEventHub = <Event>(
  onListenerError: ListenerErrorReporter<Event> = logListenerError,
): EventHub<Event> => {
  const listeners = new Set<(event: Event) => void>();

  const report = (err: unknown, event: Event) => {
    try {
      onListenerError(err, event);
    } catch (reportErr) {
      logListenerError(reportErr);
    }
  };

  const deliver = (listener: (event: Event) => void, event: Event) => {
    try {
      listener(event);
    } catch (err) {
      report(err, event);
    }
  };

  const emit = (event: Event) => {
    [...listeners].forEach((listener) => deliver(listener, event));
  };

  const subscribe = (listener: (event: Event) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { emit, subscribe };
};
