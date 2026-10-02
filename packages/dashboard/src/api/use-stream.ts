import { useEffect, useRef, useState } from 'react';
import { openStream, type StreamOptions } from './stream.js';
import { initialStreamState, type StreamState } from './stream-state.js';

export const useStream = (options: StreamOptions = {}): StreamState => {
  const {
    url,
    WebSocket,
    retryDelayMs,
    maxRetryDelayMs,
    eventLimit,
    turnsPerAgent,
  } = options;
  const onError = useRef(options.onError);
  onError.current = options.onError;
  const [state, setState] = useState(initialStreamState);

  useEffect(() => {
    const connection = openStream({
      url,
      WebSocket,
      retryDelayMs,
      maxRetryDelayMs,
      eventLimit,
      turnsPerAgent,
      onError: (err) => onError.current?.(err),
    });
    setState(connection.state);
    const unsubscribe = connection.subscribe(setState);
    return () => {
      unsubscribe();
      connection.close();
    };
  }, [
    url,
    WebSocket,
    retryDelayMs,
    maxRetryDelayMs,
    eventLimit,
    turnsPerAgent,
  ]);

  return state;
};
