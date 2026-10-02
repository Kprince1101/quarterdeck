import {
  STREAM_AFTER_PARAM,
  STREAM_PATH,
  streamMessageSchema,
  streamProtocols,
  type StreamMessage,
} from '@quarterdeck/server/stream-schema';
import {
  DEFAULT_STREAM_LIMITS,
  applyStreamMessage,
  initialStreamState,
  type StreamLimits,
  type StreamState,
} from './stream-state.js';
import { getErrorMessage } from '../lib/errors.js';

export const RETRY_DELAY_MS = 500;

export const MAX_RETRY_DELAY_MS = 10_000;

export const CLOSE_NORMAL = 1000;

export interface StreamOptions {
  url?: string | undefined;
  token?: string | undefined;
  WebSocket?: typeof WebSocket | undefined;
  retryDelayMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  eventLimit?: number | undefined;
  turnsPerAgent?: number | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

export type StreamListener = (state: StreamState) => void;

export interface StreamConnection {
  readonly state: StreamState;
  subscribe: (listener: StreamListener) => () => void;
  close: () => void;
}

const SOCKET_PROTOCOLS: Record<string, string> = { 'https:': 'wss:' };

interface PageLocation {
  protocol: string;
  host: string;
}

export const defaultStreamUrl = (): string => {
  const { location } = globalThis as { location?: PageLocation };
  if (location === undefined) {
    throw new Error('No page location; pass the stream url');
  }
  const protocol = SOCKET_PROTOCOLS[location.protocol] ?? 'ws:';
  return `${protocol}//${location.host}${STREAM_PATH}`;
};

export const resumeUrl = (url: string, cursor: number | null): string => {
  if (cursor === null) return url;
  const resumed = new URL(url);
  resumed.searchParams.set(STREAM_AFTER_PARAM, String(cursor));
  return resumed.toString();
};

const parseMessage = (data: unknown): StreamMessage => {
  if (typeof data !== 'string') {
    throw new TypeError('stream message is not text');
  }
  return streamMessageSchema.parse(JSON.parse(data));
};

export const openStream = (options: StreamOptions = {}): StreamConnection => {
  const url = options.url ?? defaultStreamUrl();
  const { token } = options;
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const open = (target: string): WebSocket => {
    if (token === undefined) return new Socket(target);
    return new Socket(target, streamProtocols(token));
  };
  const retryDelay = options.retryDelayMs ?? RETRY_DELAY_MS;
  const maxRetryDelay = options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
  const limits: StreamLimits = {
    events: options.eventLimit ?? DEFAULT_STREAM_LIMITS.events,
    turnsPerAgent: options.turnsPerAgent ?? DEFAULT_STREAM_LIMITS.turnsPerAgent,
  };
  const listeners = new Set<StreamListener>();
  let state = initialStreamState;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let closed = false;

  const update = (next: StreamState): void => {
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener(state));
  };

  const fail = (err: unknown): void => {
    options.onError?.(err);
    update({ ...state, error: getErrorMessage(err) });
  };

  const receive = (data: unknown): void => {
    let message: StreamMessage;
    try {
      message = parseMessage(data);
    } catch (err) {
      fail(err);
      return;
    }
    if (message.type === 'snapshot') retries = 0;
    update(applyStreamMessage(state, message, limits));
  };

  const connect = (): void => {
    timer = undefined;
    const ws = open(resumeUrl(url, state.cursor));
    const drop = (reason: string): void => {
      if (socket !== ws) return;
      socket = undefined;
      const delay = Math.min(maxRetryDelay, retryDelay * 2 ** retries);
      retries += 1;
      update({ ...state, status: 'reconnecting', error: reason });
      timer = setTimeout(connect, delay);
    };
    socket = ws;
    ws.addEventListener('message', (event) => {
      if (socket === ws) receive(event.data);
    });
    ws.addEventListener('error', () => {
      drop('stream failed');
    });
    ws.addEventListener('close', (event) => {
      drop(`stream closed (${event.code})`);
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const ws = socket;
    socket = undefined;
    ws?.close(CLOSE_NORMAL);
    update({ ...state, status: 'closed' });
    listeners.clear();
  };

  connect();

  return {
    get state() {
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
  };
};
