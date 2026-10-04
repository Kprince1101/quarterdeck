// @vitest-environment happy-dom
import type {
  AgentRow,
  ProjectRow,
  StreamMessage,
} from '@quarterdeck/server/stream-schema';
import type { HTMLInputElement as HappyInput } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/DeckProvider.js';
import { BoardWidget } from '../../../src/widgets/board/BoardWidget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { click } from '../../grid/events.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import { agent, agentId, project, projectId } from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

interface SentIntent {
  url: string;
  body: unknown;
}

const intentsAnswering = (status: number, body: unknown) => {
  const sent: SentIntent[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { sent, client: createIntentClient({ fetch }) };
};

const mount = (client = intentsAnswering(200, {}).client) =>
  render(
    <DeckProvider stream={stream} intents={client}>
      <BoardWidget />
    </DeckProvider>,
  );

const PAUSED_AT = '2026-10-01T13:00:00.000Z';

const snapshot = (
  projects: ProjectRow[],
  agents: AgentRow[] = [],
  pausedAt: string | null = null,
): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects, agents },
  machine: { pausedAt },
  layout: null,
});

const deliver = (message: StreamMessage) => {
  const [socket] = FakeSocket.opened;
  act(() => {
    socket?.deliver(message);
  });
};

const find = (scope: PageElement, selector: string): PageElement => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
};

const shownNames = (scope: PageElement): (string | null)[] =>
  all(scope, '.qd-board-project h3').map(({ textContent }) => textContent);

const option = (scope: PageElement, n: number): PageElement =>
  find(scope, `[data-project-option="${projectId(n)}"] input`);

const isChecked = (element: PageElement): boolean =>
  (element as unknown as HappyInput).checked;

const isDisabled = (element: PageElement): boolean =>
  (element as unknown as HappyInput).disabled;

const buttonNamed = (scope: PageElement, name: string): PageElement => {
  const button = all(scope, '.qd-board-pause button').find(
    ({ textContent }) => textContent === name,
  );
  if (button === undefined) throw new Error(`no ${name} button`);
  return button;
};

describe('board widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('registers as the board widget', () => {
    expect(WIDGETS.get('board')?.title).toBe('Board');
    expect(WIDGETS.get('board')?.component).toBe(BoardWidget);
  });

  it('shows the stream connection and each live agent', () => {
    const { container, unmount } = mount();
    const streamLine = () => find(container, '.qd-board-stream');
    expect(streamLine().textContent).toBe('Stream connecting');
    expect(textOf(container, '.qd-board-liveness')).toContain(
      'Pick a project to watch.',
    );

    deliver(
      snapshot(
        [
          project(1, 'Deck', { pausedAt: '2026-10-01T12:00:00.000Z' }),
          project(2, 'Yard'),
        ],
        [
          agent(1, 1, { name: 'wren', role: 'builder', status: 'working' }),
          agent(2, 1, { name: 'kite', role: 'builder', status: 'ended' }),
          agent(3, 1, { name: 'owl', role: 'driver', status: 'stuck' }),
        ],
      ),
    );
    expect(streamLine().textContent).toBe('Stream live');
    expect(streamLine().getAttribute('data-status')).toBe('live');
    expect(shownNames(container)).toEqual(['Deck', 'Yard']);

    const deck = find(container, `[data-project="${projectId(1)}"]`);
    expect(textOf(deck, '.qd-board-project-head')).toContain('paused');
    expect(
      all(deck, '[data-agent]').map((chip) => [
        chip.getAttribute('aria-label'),
        chip.getAttribute('data-status'),
      ]),
    ).toEqual([
      ['owl, driver, stuck', 'stuck'],
      ['wren, builder, working', 'working'],
    ]);
    const yard = find(container, `[data-project="${projectId(2)}"]`);
    expect(textOf(yard, '.qd-empty')).toBe('No live agents.');

    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'change',
        table: 'agents',
        op: 'update',
        id: agentId(1),
        row: agent(1, 1, { name: 'wren', role: 'builder', status: 'paused' }),
      });
    });
    expect(
      find(deck, `[data-agent="${agentId(1)}"]`).getAttribute('data-status'),
    ).toBe('paused');

    act(() => {
      FakeSocket.opened[0]?.drop(1006);
    });
    expect(streamLine().textContent).toBe('Stream reconnecting');
    expect(streamLine().getAttribute('title')).toBe('stream closed (1006)');
    unmount();
  });

  it('caps the projects it shows and lets the user pick which', () => {
    const { container, unmount } = mount();
    deliver(
      snapshot([
        project(1, 'A'),
        project(2, 'B'),
        project(3, 'C'),
        project(4, 'D'),
        project(5, 'E'),
      ]),
    );
    expect(shownNames(container)).toEqual(['A', 'B', 'C', 'D']);
    expect(textOf(container, '.qd-board-cap')).toBe('4 of 4 shown');
    expect(isChecked(option(container, 5))).toBe(false);
    expect(isDisabled(option(container, 5))).toBe(true);

    click(option(container, 2));
    expect(shownNames(container)).toEqual(['A', 'C', 'D']);
    expect(textOf(container, '.qd-board-cap')).toBe('3 of 4 shown');
    expect(isDisabled(option(container, 5))).toBe(false);

    click(option(container, 5));
    expect(shownNames(container)).toEqual(['A', 'C', 'D', 'E']);
    expect(isDisabled(option(container, 2))).toBe(true);
    unmount();
  });

  it('hides archived projects until the toggle shows them', () => {
    const { container, unmount } = mount();
    expect(textOf(container, '.qd-board-picker')).toContain('No projects yet.');
    deliver(
      snapshot([
        project(1, 'Live'),
        project(2, 'Old', { archivedAt: '2026-09-01T00:00:00.000Z' }),
      ]),
    );
    const toggle = find(container, '.qd-board-archived input');
    expect(textOf(container, '.qd-board-archived')).toBe('Show archived (1)');
    expect(isChecked(toggle)).toBe(false);
    expect(
      container.querySelector(`[data-project-option="${projectId(2)}"]`),
    ).toBeNull();
    expect(shownNames(container)).toEqual(['Live']);

    click(toggle);
    expect(isChecked(toggle)).toBe(true);
    expect(textOf(container, `[data-project-option="${projectId(2)}"]`)).toBe(
      'Oldarchived',
    );
    expect(shownNames(container)).toEqual(['Live', 'Old']);

    click(toggle);
    expect(shownNames(container)).toEqual(['Live']);
    unmount();
  });

  it('keeps an archived pick while archived projects are hidden', () => {
    const { container, unmount } = mount();
    deliver(
      snapshot([
        project(1, 'Live'),
        project(2, 'Next'),
        project(3, 'Old', { archivedAt: '2026-09-01T00:00:00.000Z' }),
      ]),
    );
    const toggle = find(container, '.qd-board-archived input');
    click(toggle);
    click(option(container, 2));
    expect(shownNames(container)).toEqual(['Live', 'Old']);

    click(toggle);
    expect(shownNames(container)).toEqual(['Live']);
    click(option(container, 2));
    expect(shownNames(container)).toEqual(['Live', 'Next']);

    click(toggle);
    expect(shownNames(container)).toEqual(['Live', 'Next', 'Old']);
    unmount();
  });

  it('shows the global pause and offers only the button that changes it', () => {
    const { container, unmount } = mount();
    const buttons = () =>
      all(container, '.qd-board-pause button').map(
        ({ textContent }) => textContent,
      );
    deliver(snapshot([project(1, 'Deck')]));
    expect(container.querySelector('.qd-board-paused')).toBeNull();
    expect(buttons()).toEqual(['Pause all']);

    deliver({ type: 'machine', machine: { pausedAt: PAUSED_AT } });
    expect(textOf(container, '.qd-board-paused')).toBe('Paused everywhere');
    expect(find(container, '.qd-board-paused').getAttribute('title')).toBe(
      PAUSED_AT,
    );
    expect(buttons()).toEqual(['Resume all']);

    deliver({ type: 'machine', machine: { pausedAt: null } });
    expect(container.querySelector('.qd-board-paused')).toBeNull();
    expect(buttons()).toEqual(['Pause all']);
    unmount();
  });

  it('sends pause.all and reports what the server reached', async () => {
    const { sent, client } = intentsAnswering(200, {
      intent: 'pause.all',
      status: 'applied',
      id: null,
      result: {
        paused: true,
        projects: ['deck'],
        failed: [{ project: 'yard', error: 'locked' }],
      },
    });
    const { container, unmount } = mount(client);
    const outcome = () => find(container, '.qd-board-outcome');

    click(buttonNamed(container, 'Pause all'));
    expect(isDisabled(buttonNamed(container, 'Pause all'))).toBe(true);
    await vi.waitFor(() => {
      expect(outcome().textContent).toBe(
        'Paused 1 project. Not reached: yard (locked).',
      );
    });
    expect(outcome().getAttribute('data-tone')).toBe('failed');
    expect(isDisabled(buttonNamed(container, 'Pause all'))).toBe(false);

    deliver(snapshot([], [], PAUSED_AT));
    click(buttonNamed(container, 'Resume all'));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent).toEqual([
      { url: '/api/intents/pause.all', body: { paused: true } },
      { url: '/api/intents/pause.all', body: { paused: false } },
    ]);
    unmount();
  });

  it('says so when pause.all is refused', async () => {
    const { client } = intentsAnswering(500, { error: 'Internal error' });
    const { container, unmount } = mount(client);
    click(buttonNamed(container, 'Pause all'));
    await vi.waitFor(() => {
      expect(textOf(container, '.qd-board-outcome')).toBe(
        'Could not pause all: Internal error',
      );
    });
    unmount();
  });
});
