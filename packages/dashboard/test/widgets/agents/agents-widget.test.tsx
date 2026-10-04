// @vitest-environment happy-dom
import type {
  SnapshotTables,
  StreamMessage,
} from '@quarterdeck/server/stream-schema';
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
import { POKE_TEXT } from '../../../src/widgets/agents/agent-actions.js';
import AGENTS_WIDGET, {
  AgentsWidget,
} from '../../../src/widgets/agents/AgentsWidget.js';
import { KILLING_LABEL } from '../../../src/widgets/agents/use-agent-card.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { click } from '../../grid/events.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import {
  BUILDER_ID,
  DRIVER_ID,
  INTENT_ID,
  KILLED_ID,
  NOW,
  PAUSED_ID,
  TICKET_ID,
  agent,
  agentsTables,
  ago,
  droppedEvent,
  failedEvent,
  heldEvent,
  killedEvent,
  replayedEvent,
} from './fixtures.js';

interface Sent {
  url: string;
  body: unknown;
}

interface Reply {
  status: number;
  body: object;
}

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const PENDING_KILL: Reply = {
  status: 202,
  body: {
    intent: 'agent.kill',
    status: 'pending',
    id: INTENT_ID,
    result: null,
  },
};

const replyWith = (reply: Reply, sent: Sent[]) =>
  vi.fn<typeof fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), { status: reply.status }),
    );
  });

const deliver = (...messages: StreamMessage[]): void => {
  const [socket] = FakeSocket.opened;
  if (socket === undefined) throw new Error('no socket opened');
  act(() => {
    messages.forEach((message) => socket.deliver(message));
  });
};

const mount = (
  tables: SnapshotTables,
  reply: Reply = { status: 202, body: {} },
) => {
  const sent: Sent[] = [];
  const intents = createIntentClient({
    baseUrl: 'http://deck.test',
    fetch: replyWith(reply, sent),
  });
  const rendered = render(
    <DeckProvider stream={stream} intents={intents}>
      <AgentsWidget />
    </DeckProvider>,
  );
  deliver({
    type: 'snapshot',
    cursor: 0,
    tables,
    machine: { pausedAt: null },
    layout: null,
  });
  return { ...rendered, sent };
};

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const card = (scope: PageElement, id: string): PageElement => {
  const element = scope.querySelector(`[data-agent-id="${id}"]`);
  if (element === null) throw new Error(`no card for ${id}`);
  return element;
};

const button = (scope: PageElement, name: string): PageElement => {
  const found = all(scope, 'button').find(
    ({ textContent }) => textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};

const names = (scope: PageElement): (string | null)[] =>
  all(scope, 'button').map(({ textContent }) => textContent);

const enabled = (scope: PageElement): boolean[] =>
  all(scope, 'button').map(
    (element) => element.getAttribute('disabled') === null,
  );

const tickets = (scope: PageElement): string[] =>
  all(scope, '.qd-agent-tickets li').map((chip) => chip.textContent ?? '');

const held = (scope: PageElement): string[] =>
  all(scope, '.qd-agent-held li').map((item) => item.textContent ?? '');

describe('Agents widget', () => {
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

  it('registers as the agents widget', () => {
    expect(WIDGETS.get('agents')).toBe(AGENTS_WIDGET);
    expect(AGENTS_WIDGET.title).toBe('Agents');
  });

  it('says so when there are no agents', () => {
    const { container, unmount } = mount(emptyTables());
    expect(textOf(container, '.qd-empty')).toBe('No agents yet.');
    unmount();
  });

  it('shows state, since, what it works on and the tickets it has', () => {
    const { container, unmount } = mount(agentsTables());
    expect(
      all(container, '.qd-agent').map((row) => row.getAttribute('aria-label')),
    ).toEqual(['gull', 'finch', 'heron', 'tansy']);

    const builder = card(container, BUILDER_ID);
    expect(textOf(builder, '.qd-agent-role')).toBe('builder');
    expect(textOf(builder, '.qd-agent-state')).toBe('working');
    expect(textOf(builder, '.qd-agent-since')).toBe('5m ago');
    expect(textOf(builder, '.qd-agent-working-on')).toBe('QD8c Agents widget');
    expect(tickets(builder)).toEqual([
      'QD8c Agents widgetin progress',
      'QD8a Board widgetin review',
    ]);
    expect(builder.querySelector('.qd-agent-held')).toBeNull();
    expect(
      builder.querySelector(`[data-ticket-id="${TICKET_ID}"]`),
    ).not.toBeNull();
    expect(names(builder)).toEqual([
      'Pause',
      'Poke',
      'Kill',
      'Retire',
      'Reset',
    ]);

    const paused = card(container, PAUSED_ID);
    expect(textOf(paused, '.qd-agent-state')).toBe('paused');
    expect(textOf(paused, '.qd-agent-since')).toBe('2h ago');
    expect(paused.querySelector('.qd-agent-work')).toBeNull();
    expect(names(paused)).toEqual([
      'Resume',
      'Poke',
      'Kill',
      'Retire',
      'Reset',
    ]);

    const killed = card(container, KILLED_ID);
    expect(tickets(killed)).toEqual(['QD5i kill / retire / resetblocked']);
    expect(names(killed)).toEqual(['Retire', 'Reset']);
    unmount();
  });

  it('shows held work on its agent until it is replayed or dropped', () => {
    const { container, unmount } = mount(agentsTables());
    const waiting = heldEvent(1, PAUSED_ID, 'continue: fix lint');
    const turn = heldEvent(2, DRIVER_ID, 'turn: plan voyage 2', [
      'project',
      'agent',
    ]);
    const launch = heldEvent(3, PAUSED_ID, 'assign: QD8c Agents widget');
    deliver(
      { type: 'event', event: waiting },
      { type: 'event', event: turn },
      { type: 'event', event: launch },
    );
    const paused = () => card(container, PAUSED_ID);
    const driver = () => card(container, DRIVER_ID);
    expect(held(paused())).toEqual([
      'held: continue: fix lint (agent)',
      'held: assign: QD8c Agents widget (agent)',
    ]);
    expect(held(driver())).toEqual([
      'held: turn: plan voyage 2 (project, agent)',
    ]);
    expect(held(card(container, BUILDER_ID))).toEqual([]);

    deliver({ type: 'event', event: replayedEvent(4, waiting) });
    expect(held(paused())).toEqual([
      'held: assign: QD8c Agents widget (agent)',
    ]);

    deliver({ type: 'event', event: droppedEvent(5, turn) });
    expect(held(driver())).toEqual([]);
    expect(driver().querySelector('.qd-agent-held')).toBeNull();
    unmount();
  });

  it('sends each control through its crew intent', async () => {
    const { container, sent, unmount } = mount(agentsTables());
    click(button(card(container, DRIVER_ID), 'Pause'));
    click(button(card(container, PAUSED_ID), 'Resume'));
    click(button(card(container, BUILDER_ID), 'Poke'));
    await settle();
    click(button(card(container, BUILDER_ID), 'Reset'));
    click(button(card(container, KILLED_ID), 'Retire'));
    await settle();
    expect(sent).toEqual([
      {
        url: 'http://deck.test/api/intents/agent.pause',
        body: { project: 'deck', agentId: DRIVER_ID },
      },
      {
        url: 'http://deck.test/api/intents/agent.resume',
        body: { project: 'deck', agentId: PAUSED_ID },
      },
      {
        url: 'http://deck.test/api/intents/agent.message',
        body: { project: 'deck', agentId: BUILDER_ID, text: POKE_TEXT },
      },
      {
        url: 'http://deck.test/api/intents/agent.reset',
        body: { project: 'deck', agentId: BUILDER_ID },
      },
      {
        url: 'http://deck.test/api/intents/agent.retire',
        body: { project: 'deck', agentId: KILLED_ID },
      },
    ]);
    unmount();
  });

  it('shows killing… until the stream acks the kill with agent.killed', async () => {
    const { container, sent, unmount } = mount(agentsTables(), PENDING_KILL);
    click(button(card(container, BUILDER_ID), 'Kill'));
    expect(textOf(card(container, BUILDER_ID), '.qd-agent-state')).toBe(
      KILLING_LABEL,
    );
    await settle();
    expect(sent).toEqual([
      {
        url: 'http://deck.test/api/intents/agent.kill',
        body: { project: 'deck', agentId: BUILDER_ID },
      },
    ]);
    const builder = () => card(container, BUILDER_ID);
    expect(textOf(builder(), '.qd-agent-state')).toBe(KILLING_LABEL);
    expect(builder().getAttribute('data-killing')).toBe('true');
    expect(enabled(builder())).toEqual([false, false, false, false, false]);

    deliver({
      type: 'change',
      table: 'agents',
      op: 'update',
      id: BUILDER_ID,
      row: agent(BUILDER_ID, 'tansy', { status: 'killed', updatedAt: ago(0) }),
    });
    expect(textOf(builder(), '.qd-agent-state')).toBe(KILLING_LABEL);
    expect(enabled(builder())).toEqual([false, false]);

    deliver({ type: 'event', event: killedEvent(1, INTENT_ID) });
    expect(textOf(builder(), '.qd-agent-state')).toBe('killed');
    expect(builder().getAttribute('data-killing')).toBe('false');
    expect(textOf(builder(), '.qd-agent-since')).toBe('just now');
    expect(names(builder())).toEqual(['Retire', 'Reset']);
    expect(enabled(builder())).toEqual([true, true]);
    unmount();
  });

  it('drops killing… and shows why when the server refuses the kill', async () => {
    const { container, unmount } = mount(agentsTables(), {
      status: 409,
      body: { error: `agent ${BUILDER_ID} is already killed` },
    });
    click(button(card(container, BUILDER_ID), 'Kill'));
    await settle();
    const builder = card(container, BUILDER_ID);
    expect(textOf(builder, '.qd-agent-state')).toBe('working');
    expect(textOf(builder, '[role="alert"]')).toBe(
      `agent ${BUILDER_ID} is already killed`,
    );
    expect(enabled(builder)).toEqual([true, true, true, true, true]);
    unmount();
  });

  it('drops killing… when the stream records that the kill failed', async () => {
    const { container, unmount } = mount(agentsTables(), PENDING_KILL);
    click(button(card(container, BUILDER_ID), 'Kill'));
    await settle();
    deliver({ type: 'event', event: failedEvent(1, INTENT_ID) });
    const builder = card(container, BUILDER_ID);
    expect(textOf(builder, '.qd-agent-state')).toBe('working');
    expect(textOf(builder, '[role="alert"]')).toBe('session would not close');
    expect(enabled(builder)).toEqual([true, true, true, true, true]);
    unmount();
  });
});
