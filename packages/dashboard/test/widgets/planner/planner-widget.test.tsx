// @vitest-environment happy-dom
import type {
  StreamEvent,
  StreamMessage,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/deck.js';
import PLANNER_WIDGET, {
  PlannerWidget,
} from '../../../src/widgets/planner/planner.widget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { choose } from '../../grid/events.js';
import {
  click,
  find,
  findAll,
  mount,
  press,
  typeInto,
  valueOf,
  type DomElement,
  type Mounted,
} from '../../primitives/dom.js';
import type { PageElement } from '../../shell/page.js';
import {
  DECK,
  DOCS,
  INTENT_1,
  PROJECTS,
  SHIP,
  SITE,
  cleared,
  human,
  plannerEvent,
  proposed,
  reply,
  ticket,
} from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

interface Sent {
  intent: string;
  body: unknown;
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status });

const fakeServer = () => {
  const sent: Sent[] = [];
  const refusals: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const intent = String(input).split('/').at(-1) ?? '';
    sent.push({ intent, body: JSON.parse(String(init?.body)) });
    const refusal = refusals.shift();
    if (refusal !== undefined) {
      return Promise.resolve(json({ error: refusal }, 409));
    }
    return Promise.resolve(
      json({ intent, status: 'pending', id: INTENT_1, result: null }, 202),
    );
  });
  return { sent, refusals, client: createIntentClient({ fetch }) };
};

const mounted: Mounted[] = [];

const mountPlanner = () => {
  const server = fakeServer();
  const view = mount(
    <DeckProvider stream={stream} intents={server.client}>
      <PlannerWidget />
    </DeckProvider>,
  );
  mounted.push(view);
  return { ...view, ...server };
};

const deliver = (...messages: StreamMessage[]): void => {
  const [socket] = FakeSocket.opened;
  if (socket === undefined) throw new Error('no socket opened');
  act(() => {
    messages.forEach((message) => socket.deliver(message));
  });
};

const snapshot = (tickets: TicketRow[] = []): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects: PROJECTS, tickets },
  machine: { pausedAt: null },
});

const arrive = (...events: StreamEvent[]): StreamMessage[] =>
  events.map((event) => ({ type: 'event', event }));

const changed = (row: TicketRow): StreamMessage => ({
  type: 'change',
  table: 'tickets',
  op: 'update',
  id: row.id,
  row,
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const button = (scope: DomElement, label: string): DomElement => {
  const match = findAll(scope, 'button').find(
    ({ textContent }) => textContent === label,
  );
  if (match === undefined) throw new Error(`no ${label} button`);
  return match;
};

const labels = (scope: DomElement): string[] =>
  findAll(scope, 'button').map(({ textContent }) => textContent ?? '');

const card = (scope: DomElement, ticketId: string): DomElement =>
  find(scope, `article[data-ticket-id="${ticketId}"]`);

const log = (scope: DomElement): string[] =>
  findAll(scope, '.qd-planner-log > li').map((item) => {
    const title = item.querySelector('h3')?.textContent;
    if (title !== undefined) return `proposal: ${title}`;
    return `${item.querySelector('.qd-planner-author')?.textContent}: ${
      item.querySelector('p')?.textContent
    }`;
  });

const pick = (scope: DomElement, projectId: string): void => {
  choose(
    find(scope, '.qd-planner-project select') as unknown as PageElement,
    projectId,
  );
};

describe('Planner widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    mounted.splice(0).forEach(({ unmount }) => unmount());
    FakeSocket.opened = [];
  });

  it('registers as the planner widget', () => {
    expect(WIDGETS.get('planner')).toBe(PLANNER_WIDGET);
    expect(PLANNER_WIDGET.title).toBe('Planner');
  });

  it('waits for a project before it can plan', () => {
    const { container } = mountPlanner();
    expect(find(container, '.qd-empty').textContent).toBe(
      'No project yet. Create one to plan.',
    );
    expect(find(container, 'textarea').hasAttribute('disabled')).toBe(true);
    expect(button(container, 'New conversation').hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('picks the first project and invites a first message', () => {
    const { container } = mountPlanner();
    deliver(snapshot());
    const select = find(container, '.qd-planner-project select');
    expect(valueOf(select)).toBe(DECK);
    expect(
      findAll(select, 'option').map(({ textContent }) => textContent),
    ).toEqual(['Deck', 'Site']);
    expect(find(container, '.qd-empty').textContent).toBe(
      'No conversation yet. Tell the Planner what to build.',
    );
    expect(find(container, 'textarea').hasAttribute('disabled')).toBe(false);
  });

  it('shows the conversation with proposed tickets inline', () => {
    const { container } = mountPlanner();
    deliver(
      snapshot([
        ticket(SHIP, 'Ship it', { body: 'every page', dependsOn: [DOCS] }),
        ticket(DOCS, 'Write docs', { status: 'open' }),
      ]),
      ...arrive(
        human(1, 'build the site'),
        proposed(2, SHIP, 'Ship it'),
        proposed(3, DOCS, 'Write docs'),
        reply(4, 'Two tickets.'),
      ),
    );
    expect(log(container)).toEqual([
      'You: build the site',
      'proposal: Ship it',
      'proposal: Write docs',
      'Planner: Two tickets.',
    ]);
    const ship = card(container, SHIP);
    expect(find(ship, '.qd-proposal-body').textContent).toBe('every page');
    expect(find(ship, '.qd-proposal-dep').textContent).toBe('Write docs');
    expect(find(ship, '.qd-proposal-status').textContent).toBe('Proposed');
    expect(labels(ship)).toEqual(['Approve', 'Edit', 'Reject']);
    const docs = card(container, DOCS);
    expect(find(docs, '.qd-proposal-status').textContent).toBe('Approved');
    expect(labels(docs)).toEqual([]);
  });

  it('approves a proposal with ticket.approve and follows the stream', async () => {
    const { container, sent } = mountPlanner();
    const row = ticket(SHIP, 'Ship it');
    deliver(snapshot([row]), ...arrive(proposed(1, SHIP, 'Ship it')));
    await click(button(card(container, SHIP), 'Approve'));
    await settle();
    expect(sent).toEqual([
      { intent: 'ticket.approve', body: { project: 'deck', ticketId: SHIP } },
    ]);
    deliver(changed({ ...row, status: 'open' }));
    expect(find(card(container, SHIP), '.qd-proposal-status').textContent).toBe(
      'Approved',
    );
    expect(labels(card(container, SHIP))).toEqual([]);
  });

  it('rejects a proposal with ticket.reject', async () => {
    const { container, sent } = mountPlanner();
    const row = ticket(SHIP, 'Ship it');
    deliver(snapshot([row]), ...arrive(proposed(1, SHIP, 'Ship it')));
    await click(button(card(container, SHIP), 'Reject'));
    await settle();
    expect(sent).toEqual([
      { intent: 'ticket.reject', body: { project: 'deck', ticketId: SHIP } },
    ]);
    deliver(changed({ ...row, status: 'rejected' }));
    expect(find(card(container, SHIP), '.qd-proposal-status').textContent).toBe(
      'Rejected',
    );
  });

  it('edits a proposal with ticket.update', async () => {
    const { container, sent } = mountPlanner();
    deliver(
      snapshot([ticket(SHIP, 'Ship it', { body: 'old body' })]),
      ...arrive(proposed(1, SHIP, 'Ship it')),
    );
    await click(button(card(container, SHIP), 'Edit'));
    const title = find(card(container, SHIP), '.qd-proposal-editor input');
    const body = find(card(container, SHIP), '.qd-proposal-editor textarea');
    expect(valueOf(title)).toBe('Ship it');
    expect(valueOf(body)).toBe('old body');
    expect(labels(card(container, SHIP))).toEqual(['Save', 'Cancel']);

    typeInto(title, '   ');
    expect(button(card(container, SHIP), 'Save').hasAttribute('disabled')).toBe(
      true,
    );
    typeInto(title, 'Ship the site');
    typeInto(body, 'new body');
    await click(button(card(container, SHIP), 'Save'));
    await settle();
    expect(sent).toEqual([
      {
        intent: 'ticket.update',
        body: {
          project: 'deck',
          ticketId: SHIP,
          title: 'Ship the site',
          body: 'new body',
        },
      },
    ]);
    expect(labels(card(container, SHIP))).toEqual([
      'Approve',
      'Edit',
      'Reject',
    ]);
  });

  it('cancels an edit without sending anything', async () => {
    const { container, sent } = mountPlanner();
    deliver(
      snapshot([ticket(SHIP, 'Ship it')]),
      ...arrive(proposed(1, SHIP, 'Ship it')),
    );
    await click(button(card(container, SHIP), 'Edit'));
    await click(button(card(container, SHIP), 'Cancel'));
    expect(sent).toEqual([]);
    expect(labels(card(container, SHIP))).toEqual([
      'Approve',
      'Edit',
      'Reject',
    ]);
  });

  it('shows a refusal on the card and keeps it decidable', async () => {
    const { container, refusals } = mountPlanner();
    refusals.push('a dependency is still proposed');
    deliver(
      snapshot([ticket(SHIP, 'Ship it')]),
      ...arrive(proposed(1, SHIP, 'Ship it')),
    );
    await click(button(card(container, SHIP), 'Approve'));
    await settle();
    expect(find(card(container, SHIP), '[role="alert"]').textContent).toBe(
      'a dependency is still proposed',
    );
    expect(
      button(card(container, SHIP), 'Approve').hasAttribute('disabled'),
    ).toBe(false);
  });

  it('sends a message with planner.message and shows it until the Planner takes it', async () => {
    const { container, sent } = mountPlanner();
    deliver(snapshot());
    typeInto(find(container, 'textarea'), 'plan the docs');
    await press(find(container, 'textarea'), 'Enter');
    await settle();
    expect(sent).toEqual([
      {
        intent: 'planner.message',
        body: { project: 'deck', text: 'plan the docs' },
      },
    ]);
    expect(log(container)).toEqual([
      'You, waiting for the Planner: plan the docs',
    ]);
    deliver(...arrive(human(1, 'plan the docs', INTENT_1)));
    expect(log(container)).toEqual(['You: plan the docs']);
  });

  it('starts a new conversation with planner.new', async () => {
    const { container, sent } = mountPlanner();
    deliver(snapshot(), ...arrive(human(1, 'old idea'), reply(2, 'Sure.')));
    await click(button(container, 'New conversation'));
    await settle();
    expect(sent).toEqual([
      { intent: 'planner.new', body: { project: 'deck' } },
    ]);
    deliver(...arrive(plannerEvent(3, 'planner.new'), cleared(4)));
    expect(findAll(container, '.qd-planner-log')).toHaveLength(0);
    expect(find(container, '.qd-empty').textContent).toContain(
      'No conversation yet.',
    );
  });

  it('says why a new conversation could not start', async () => {
    const { container, refusals } = mountPlanner();
    refusals.push('project is open elsewhere');
    deliver(snapshot());
    await click(button(container, 'New conversation'));
    await settle();
    expect(find(container, '.qd-planner-error').textContent).toBe(
      'project is open elsewhere',
    );
  });

  it('switches project for the conversation and the intents', async () => {
    const { container, sent } = mountPlanner();
    deliver(
      snapshot(),
      ...arrive(
        human(1, 'deck talk'),
        plannerEvent(2, 'planner.reply', {
          projectId: SITE,
          payload: { text: 'site talk' },
        }),
      ),
    );
    expect(log(container)).toEqual(['You: deck talk']);
    pick(container, SITE);
    expect(log(container)).toEqual(['Planner: site talk']);
    await click(button(container, 'New conversation'));
    await settle();
    expect(sent).toEqual([
      { intent: 'planner.new', body: { project: 'site' } },
    ]);
  });
});
