// @vitest-environment happy-dom
import type { StreamMessage } from '@quarterdeck/server/stream-schema';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSE_NORMAL,
  emptyTables,
  useStream,
  type StreamOptions,
  type StreamState,
} from '../../src/api/index.js';
import { FAKE_WEBSOCKET, FakeSocket } from './fake-socket.js';

const happyDomPage = globalThis as unknown as {
  document: {
    createElement: (tag: string) => Parameters<typeof createRoot>[0];
  };
};

const URL_A = 'ws://127.0.0.1:4317/ws';
const URL_B = 'ws://127.0.0.1:4318/ws';

const SNAPSHOT: StreamMessage = {
  type: 'snapshot',
  cursor: 3,
  tables: emptyTables(),
  machine: { pausedAt: null },
};

interface Rendered {
  state: () => StreamState;
  rerender: (options: StreamOptions) => void;
  unmount: () => void;
}

const renderUseStream = (initial: StreamOptions): Rendered => {
  let latest: StreamState | undefined;
  const Probe = ({ options }: { options: StreamOptions }) => {
    latest = useStream(options);
    return null;
  };
  const root: Root = createRoot(happyDomPage.document.createElement('div'));
  const render = (options: StreamOptions) => {
    act(() => {
      root.render(createElement(Probe, { options }));
    });
  };
  render(initial);
  return {
    state: () => {
      if (latest === undefined) throw new Error('not rendered');
      return latest;
    },
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
};

const options = (url: string): StreamOptions => ({
  url,
  WebSocket: FAKE_WEBSOCKET,
});

describe('useStream', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('renders the stream state as messages arrive', () => {
    const view = renderUseStream(options(URL_A));
    expect(view.state().status).toBe('connecting');
    const [socket] = FakeSocket.opened;
    expect(socket?.url).toBe(URL_A);

    act(() => {
      socket?.deliver(SNAPSHOT);
    });
    expect(view.state()).toMatchObject({ status: 'live', cursor: 3 });
    view.unmount();
  });

  it('keeps one socket across renders with the same options', () => {
    const view = renderUseStream(options(URL_A));
    view.rerender(options(URL_A));
    expect(FakeSocket.opened).toHaveLength(1);
    view.unmount();
  });

  it('closes the socket on unmount', () => {
    const view = renderUseStream(options(URL_A));
    view.unmount();
    expect(FakeSocket.opened.map(({ closedWith }) => closedWith)).toEqual([
      CLOSE_NORMAL,
    ]);
  });

  it('starts over on a new url', () => {
    const view = renderUseStream(options(URL_A));
    act(() => {
      FakeSocket.opened[0]?.deliver(SNAPSHOT);
    });
    view.rerender(options(URL_B));
    const [first, second] = FakeSocket.opened;
    expect(first?.closedWith).toBe(CLOSE_NORMAL);
    expect(second?.url).toBe(URL_B);
    expect(view.state()).toMatchObject({ status: 'connecting', cursor: null });
    view.unmount();
  });
});
