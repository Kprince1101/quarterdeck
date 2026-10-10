// @vitest-environment happy-dom
import type {
  KeepAwakeState,
  StreamMessage,
} from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/DeckProvider.js';
import { KeepAwakeControl } from '../../src/shell/KeepAwakeControl.js';
import {
  KEEP_AWAKE_EXPLANATION,
  KEEP_AWAKE_WAITING,
  formatTimeLeft,
  keepAwakeView,
} from '../../src/shell/keep-awake-model.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { all, render, type PageElement } from './page.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const HOUR_MS = 60 * 60 * 1000;
const MISSING_REASON =
  'systemd-inhibit is not on PATH, so Quarterdeck cannot keep this computer awake.';

const OFF: KeepAwakeState = {
  on: false,
  mode: null,
  expiresAt: null,
  available: true,
  unavailableReason: null,
};

interface Clickable extends PageElement {
  click: () => void;
  disabled: boolean;
  value: string;
  dispatchEvent: (event: Event) => boolean;
}

const snapshot = (keepAwake: KeepAwakeState | null): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: emptyTables(),
  machine: { pausedAt: null },
  layout: null,
  workspace: null,
  keepAwake,
});

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

type Answer = { status: number; error: string } | KeepAwakeState;

const replyTo = (intent: string, answer: Answer): Response => {
  if ('error' in answer) {
    return new Response(JSON.stringify({ error: answer.error }), {
      status: answer.status,
    });
  }
  return new Response(
    JSON.stringify({
      intent,
      status: 'applied',
      id: null,
      result: { keepAwake: answer },
    }),
    { status: 200 },
  );
};

const mount = async (answer: Answer = OFF) => {
  const sent: { url: string; body: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(replyTo(String(url), answer));
  });
  const page = render(
    <DeckProvider stream={stream} intents={createIntentClient({ fetch })}>
      <KeepAwakeControl />
    </DeckProvider>,
  );
  await flush();
  const deliver = (message: StreamMessage) => {
    act(() => {
      FakeSocket.opened.at(-1)?.deliver(message);
    });
  };
  return { ...page, sent, deliver };
};

const parts = (container: PageElement) => {
  const button = container.querySelector('.qd-keep-awake button') as Clickable;
  const select = container.querySelector('.qd-keep-awake select') as Clickable;
  return {
    button,
    select,
    label: button.textContent,
    pressed: button.getAttribute('aria-pressed'),
    note: container.querySelector('.qd-keep-awake-note')?.textContent,
    title: container.querySelector('.qd-keep-awake')?.getAttribute('title'),
    options: all(container, '.qd-keep-awake option').map(
      (option) => option.textContent,
    ),
  };
};

const click = async (element: Clickable) => {
  act(() => {
    element.click();
  });
  await flush();
};

const choose = async (select: Clickable, value: string) => {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};

describe('keep-awake control', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
    vi.useRealTimers();
  });

  it('explains what it keeps awake, in the tooltip and by the control', async () => {
    const { container, deliver, unmount } = await mount();
    deliver(snapshot(OFF));
    const control = parts(container);
    expect(control.note).toBe(KEEP_AWAKE_EXPLANATION);
    expect(control.title).toBe(KEEP_AWAKE_EXPLANATION);
    expect(KEEP_AWAKE_EXPLANATION).toBe(
      'Keeps your computer from sleeping so agents keep working. Your screen can still turn off and lock. On a laptop, closing the lid on battery still sleeps.',
    );
    expect(control.options).toEqual([
      '30m',
      '1h',
      '2h',
      '4h',
      '8h',
      'Until voyage ends',
    ]);
    expect(control.label).toBe('Keep awake');
    expect(control.pressed).toBe('false');
    expect(control.button.disabled).toBe(false);
    unmount();
  });

  it('starts for the chosen time, or until the voyage ends', async () => {
    const { container, deliver, sent, unmount } = await mount();
    deliver(snapshot(OFF));

    await click(parts(container).button);
    await choose(parts(container).select, 'voyage');
    await click(parts(container).button);

    expect(sent).toEqual([
      { url: '/api/intents/keepAwake.start', body: { minutes: 60 } },
      {
        url: '/api/intents/keepAwake.start',
        body: { untilVoyageEnds: true },
      },
    ]);
    unmount();
  });

  it('counts down while on and turns off when clicked', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { container, deliver, sent, unmount } = await mount();
    deliver(
      snapshot({
        ...OFF,
        on: true,
        mode: 'duration',
        expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
      }),
    );
    expect(parts(container).label).toBe('Awake: 1h 00m left');
    expect(parts(container).pressed).toBe('true');

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(parts(container).label).toBe('Awake: 58m 59s left');

    await click(parts(container).button);
    expect(sent).toEqual([{ url: '/api/intents/keepAwake.stop', body: {} }]);

    deliver({ type: 'keepAwake', keepAwake: OFF });
    expect(parts(container).label).toBe('Keep awake');
    unmount();
  });

  it('says until voyage ends when there is no time limit', async () => {
    const { container, deliver, unmount } = await mount();
    deliver(snapshot({ ...OFF, on: true, mode: 'untilVoyageEnds' }));
    expect(parts(container).label).toBe('Awake until voyage ends');
    unmount();
  });

  it('replaces the hold when the choice changes while on', async () => {
    const { container, deliver, sent, unmount } = await mount();
    deliver(snapshot({ ...OFF, on: true, mode: 'untilVoyageEnds' }));
    await choose(parts(container).select, '240');
    expect(sent).toEqual([
      { url: '/api/intents/keepAwake.start', body: { minutes: 240 } },
    ]);
    unmount();
  });

  it('is disabled with the reason when the tool is missing', async () => {
    const { container, deliver, sent, unmount } = await mount();
    deliver(
      snapshot({ ...OFF, available: false, unavailableReason: MISSING_REASON }),
    );
    const control = parts(container);
    expect(control.button.disabled).toBe(true);
    expect(control.select.disabled).toBe(true);
    expect(control.note).toBe(MISSING_REASON);
    expect(control.title).toBe(`${MISSING_REASON} ${KEEP_AWAKE_EXPLANATION}`);

    await click(control.button);
    expect(sent).toEqual([]);
    unmount();
  });

  it('shows why the server refused', async () => {
    const { container, deliver, unmount } = await mount({
      status: 409,
      error: MISSING_REASON,
    });
    deliver(snapshot(OFF));
    await click(parts(container).button);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      MISSING_REASON,
    );
    unmount();
  });

  it('waits, disabled, until the stream says', () => {
    expect(keepAwakeView(null, 0)).toMatchObject({
      isDisabled: true,
      note: KEEP_AWAKE_WAITING,
    });
  });

  it('formats the time left', () => {
    expect(
      [8 * HOUR_MS, HOUR_MS + 1, 59 * 60_000, 61_000, 999, 0, -5].map(
        formatTimeLeft,
      ),
    ).toEqual(['8h 00m', '1h 00m', '59m 00s', '1m 01s', '1s', '0s', '0s']);
  });
});
