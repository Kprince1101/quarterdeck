// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app.js';
import { DEMO_ROUND_PLANS } from '../../src/demo/demo-plans.js';
import { createDemoServer } from '../../src/demo/demo-server.js';
import { PLANNER_ASK } from '../../src/demo/demo-seed.js';
import { render, textOf } from '../shell/page.js';

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

describe('the dashboard on the demo server', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs every widget on the demo without a socket or a request', async () => {
    const network = vi.fn(() => {
      throw new Error('the demo touched the network');
    });
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('WebSocket', network);
    const server = createDemoServer();
    const { container, unmount } = render(
      <App mode="Demo" {...server.sources} />,
    );
    await flush();
    await flush();

    expect(textOf(container, '.qd-mode')).toBe('Demo');
    expect(textOf(container, '[role="status"]')).toBe('Live');
    expect(textOf(container, '[aria-label="Project"]')).toContain(
      DEMO_ROUND_PLANS[1]?.goal,
    );
    expect(textOf(container, '[aria-label="Planner"]')).toContain(PLANNER_ASK);
    expect(textOf(container, '[aria-label="Events"]')).toContain('turn.ended');
    expect(textOf(container, '[aria-label="Usage"]')).toMatch(/\d+%/);

    act(() => {
      server.step();
    });
    await flush();
    expect(textOf(container, '[aria-label="Cards"]')).toContain(
      DEMO_ROUND_PLANS[1]?.question.question,
    );
    expect(network).not.toHaveBeenCalled();
    unmount();
    server.stop();
  });
});
