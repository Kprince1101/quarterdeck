// @vitest-environment happy-dom
import type { UsageReadResult } from '@quarterdeck/server/intents';
import type { StreamMessage, TurnRow } from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createIntentClient, emptyTables } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/DeckProvider.js';
import { defaultLayout } from '../../../src/grid/default-layout.js';
import { NOW_TICK_MS } from '../../../src/lib/use-now.js';
import USAGE_WIDGET, {
  UsageWidget,
} from '../../../src/widgets/usage/UsageWidget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { render, textOf, type PageElement } from '../../shell/page.js';
import { NOW, at, project, turn, usage } from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

type Answer = UsageReadResult | { status: number; error: string };

interface Harness {
  container: PageElement;
  sent: { url: string; body: unknown }[];
  answer: (next: Answer) => void;
  deliver: (message: StreamMessage) => void;
  unmount: () => void;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const replyTo = (answer: Answer): Response => {
  if ('error' in answer) {
    return new Response(JSON.stringify({ error: answer.error }), {
      status: answer.status,
    });
  }
  return new Response(
    JSON.stringify({
      intent: 'usage.read',
      status: 'applied',
      id: null,
      result: answer,
    }),
    { status: 200 },
  );
};

const snapshot = (turns: TurnRow[]): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects: [project('deck')], turns },
  machine: { pausedAt: null },
});

const mount = async (
  first: Answer,
  turns: TurnRow[] = [],
): Promise<Harness> => {
  let current = first;
  const sent: Harness['sent'] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(replyTo(current));
  });
  const intents = createIntentClient({ fetch });
  const { container, unmount } = render(
    <DeckProvider stream={stream} intents={intents}>
      <UsageWidget />
    </DeckProvider>,
  );
  const deliver = (message: StreamMessage) => {
    act(() => {
      FakeSocket.opened[0]?.deliver(message);
    });
  };
  deliver(snapshot(turns));
  await flush();
  return {
    container,
    sent,
    answer: (next) => {
      current = next;
    },
    deliver,
    unmount,
  };
};

const percent = (container: PageElement) => {
  const element = container.querySelector('.qd-usage-percent');
  if (element === null) return null;
  return {
    text: element.textContent,
    level: element.getAttribute('data-level'),
  };
};

describe('Usage widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.opened = [];
  });

  it('registers as the usage widget and starts in the tray', () => {
    expect(WIDGETS.get('usage')).toBe(USAGE_WIDGET);
    expect(USAGE_WIDGET.title).toBe('Usage');
    const item = defaultLayout(WIDGETS).items.find(
      ({ widget }) => widget === 'usage',
    );
    expect(item?.hidden).toBe(true);
  });

  it('says it is reading before the first answer', () => {
    const { container, unmount } = render(
      <DeckProvider stream={stream}>
        <UsageWidget />
      </DeckProvider>,
    );
    expect(textOf(container, '.qd-empty')).toBe('Reading usage…');
    unmount();
  });

  it('sends usage.read for the stream’s project and shows red from 80%', async () => {
    const { container, sent, unmount } = await mount(usage(80_000, 100_000));
    expect(sent).toEqual([
      { url: '/api/intents/usage.read', body: { project: 'deck' } },
    ]);
    expect(percent(container)).toEqual({ text: '80% of cap', level: 'red' });
    expect(textOf(container, '.qd-usage-tokens')).toBe(
      '80,000 tokens in the last 5h, this project',
    );
    expect(container.querySelector('.qd-usage-no-cap')).toBeNull();
    unmount();
  });

  it('shows amber from 60% and the plain colour below it', async () => {
    const amber = await mount(usage(60, 100));
    expect(percent(amber.container)?.level).toBe('amber');
    amber.unmount();
    FakeSocket.opened = [];

    const ok = await mount(usage(59, 100));
    expect(percent(ok.container)).toEqual({ text: '59% of cap', level: 'ok' });
    ok.unmount();
  });

  it('shows the total and No cap set without a cap', async () => {
    const { container, unmount } = await mount(usage(1234, null));
    expect(percent(container)).toBeNull();
    expect(textOf(container, '.qd-usage-no-cap')).toBe('No cap set');
    expect(textOf(container, '.qd-usage-tokens')).toBe(
      '1,234 tokens in the last 5h, this project',
    );
    unmount();
  });

  it('reads again as the clock moves', async () => {
    const { container, sent, answer, unmount } = await mount(usage(42, 100));
    expect(percent(container)?.text).toBe('42% of cap');
    answer(usage(2, 100));
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    await flush();
    expect(sent).toHaveLength(2);
    expect(percent(container)?.text).toBe('2% of cap');
    unmount();
  });

  it('reads again when a turn ends, not while one runs', async () => {
    const running = turn(1, null);
    const { container, sent, answer, deliver, unmount } = await mount(
      usage(10, 100),
      [running],
    );
    answer(usage(22, 100));
    deliver({
      type: 'change',
      table: 'turns',
      op: 'update',
      id: 1,
      row: { ...running, stopReason: null },
    });
    await flush();
    expect(sent).toHaveLength(1);
    deliver({
      type: 'change',
      table: 'turns',
      op: 'update',
      id: 1,
      row: { ...running, endedAt: at(0) },
    });
    await flush();
    expect(sent).toHaveLength(2);
    expect(percent(container)?.text).toBe('22% of cap');
    unmount();
  });

  it('says why a read failed and keeps the last reading', async () => {
    const { container, answer, unmount } = await mount(usage(7, null));
    answer({ status: 409, error: 'rules.local.lifecycle.json: bad window' });
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    await flush();
    expect(textOf(container, '[role="alert"]')).toBe(
      'rules.local.lifecycle.json: bad window',
    );
    expect(textOf(container, '.qd-usage-tokens')).toBe(
      '7 tokens in the last 5h, this project',
    );
    unmount();
  });
});
