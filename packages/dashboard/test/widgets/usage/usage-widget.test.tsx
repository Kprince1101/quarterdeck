// @vitest-environment happy-dom
import type { TurnRow } from '@quarterdeck/server/stream-schema';
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
import { emptyTables, type RulesView } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/deck.js';
import { defaultLayout } from '../../../src/grid/default-layout.js';
import { NOW_TICK_MS } from '../../../src/lib/use-now.js';
import { CAP_REFRESH_MS } from '../../../src/widgets/usage/use-window-cap.js';
import USAGE_WIDGET, {
  UsageWidget,
} from '../../../src/widgets/usage/usage.widget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { rulesView, type RuleOverrides } from '../../rules/fixtures.js';
import { textOf, render, type PageElement } from '../../shell/page.js';
import { HOUR, NOW, OTHER_AGENT, ago, turn } from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const NO_CAP_LAYER: RuleOverrides = {};

const capLayer = (cap: number): RuleOverrides => ({
  machine: JSON.stringify({ usage: { windowCapTokens: cap } }),
});

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

interface Harness {
  container: PageElement;
  reads: (string | null)[];
  setMachine: (machine: RuleOverrides) => void;
  unmount: () => void;
}

const mount = async (
  turns: TurnRow[],
  machine: RuleOverrides,
  refuse: string | null = null,
): Promise<Harness> => {
  let lifecycle = machine;
  const reads: (string | null)[] = [];
  const rules = (project: string | null): Promise<RulesView> => {
    reads.push(project);
    if (refuse !== null) return Promise.reject(new Error(refuse));
    return Promise.resolve(rulesView({ lifecycle }));
  };
  const { container, unmount } = render(
    <DeckProvider stream={stream} rules={rules}>
      <UsageWidget />
    </DeckProvider>,
  );
  act(() => {
    FakeSocket.opened[0]?.deliver({
      type: 'snapshot',
      cursor: 0,
      tables: { ...emptyTables(), turns },
    });
  });
  await flush();
  return {
    container,
    reads,
    setMachine: (next) => {
      lifecycle = next;
    },
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

  it('shows the cap percent in red at 80% and the window total', async () => {
    const { container, reads, unmount } = await mount(
      [
        turn(1, ago(HOUR), 50_000, 10_000),
        turn(2, ago(2 * HOUR), 15_000, 5_000, OTHER_AGENT),
        turn(3, ago(6 * HOUR), 900_000, 0),
      ],
      capLayer(100_000),
    );
    expect(reads).toEqual([null]);
    expect(percent(container)).toEqual({ text: '80% of cap', level: 'red' });
    expect(textOf(container, '.qd-usage-tokens')).toBe(
      '80,000 tokens in the last 5h',
    );
    expect(container.querySelector('.qd-usage-no-cap')).toBeNull();
    unmount();
  });

  it('shows amber from 60% and the plain colour below it', async () => {
    const amber = await mount([turn(1, ago(HOUR), 60, 0)], capLayer(100));
    expect(percent(amber.container)?.level).toBe('amber');
    amber.unmount();
    FakeSocket.opened = [];

    const ok = await mount([turn(1, ago(HOUR), 59, 0)], capLayer(100));
    expect(percent(ok.container)).toEqual({ text: '59% of cap', level: 'ok' });
    ok.unmount();
  });

  it('shows the total and No cap set without a cap', async () => {
    const { container, unmount } = await mount(
      [turn(1, ago(HOUR), 1200, 34)],
      NO_CAP_LAYER,
    );
    expect(percent(container)).toBeNull();
    expect(textOf(container, '.qd-usage-no-cap')).toBe('No cap set');
    expect(textOf(container, '.qd-usage-tokens')).toBe(
      '1,234 tokens in the last 5h',
    );
    unmount();
  });

  it('drops a turn once it leaves the window', async () => {
    const { container, unmount } = await mount(
      [turn(1, ago(5 * HOUR - 1000), 40, 0), turn(2, ago(HOUR), 2, 0)],
      capLayer(100),
    );
    expect(percent(container)?.text).toBe('42% of cap');
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    expect(percent(container)?.text).toBe('2% of cap');
    unmount();
  });

  it('picks up a new cap from the rules', async () => {
    const { container, reads, setMachine, unmount } = await mount(
      [turn(1, ago(HOUR), 50, 0)],
      NO_CAP_LAYER,
    );
    expect(textOf(container, '.qd-usage-no-cap')).toBe('No cap set');
    setMachine(capLayer(200));
    act(() => {
      vi.advanceTimersByTime(CAP_REFRESH_MS);
    });
    await flush();
    expect(reads).toEqual([null, null]);
    expect(percent(container)).toEqual({ text: '25% of cap', level: 'ok' });
    unmount();
  });

  it('says why the cap could not be read and still shows the total', async () => {
    const { container, unmount } = await mount(
      [turn(1, ago(HOUR), 7, 0)],
      NO_CAP_LAYER,
      'Reading the rules failed with HTTP 500',
    );
    expect(textOf(container, '[role="alert"]')).toBe(
      'Reading the rules failed with HTTP 500',
    );
    expect(container.querySelector('.qd-usage-no-cap')).toBeNull();
    expect(textOf(container, '.qd-usage-tokens')).toBe(
      '7 tokens in the last 5h',
    );
    unmount();
  });
});
