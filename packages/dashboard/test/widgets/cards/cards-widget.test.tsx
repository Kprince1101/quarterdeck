// @vitest-environment happy-dom
import type { CardRow, StreamMessage } from '@quarterdeck/server/stream-schema';
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
import {
  LOOKUP_LABEL,
  LOOKUP_NOTE,
} from '../../../src/widgets/cards/card-deck.js';
import CARDS_WIDGET, {
  CardsWidget,
} from '../../../src/widgets/cards/CardsWidget.js';
import {
  NO_PROJECT_ERROR,
  REPLY_LABEL,
} from '../../../src/widgets/cards/use-card-reply.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import {
  buttonNamed,
  check,
  clickButton,
  find,
  isChecked,
  isDisabled,
  typeAndSend,
} from './dom.js';
import {
  MINK,
  NOW,
  PROJECTS,
  STRAY,
  TICKET,
  agent,
  ago,
  askCard,
  card,
  cardId,
  mergeCard,
  signInCard,
  ticket,
} from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

interface Sent {
  url: string;
  body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fakeServer = (reply: () => Response = () => json(200, {})) => {
  const sent: Sent[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(reply());
  });
  const intents = createIntentClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { sent, intents };
};

const deliver = (...messages: StreamMessage[]): void => {
  const [socket] = FakeSocket.opened;
  if (socket === undefined) throw new Error('no socket opened');
  act(() => {
    messages.forEach((message) => socket.deliver(message));
  });
};

const snapshot = (cards: CardRow[]): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: {
    ...emptyTables(),
    projects: PROJECTS,
    agents: [agent(MINK, 'mink')],
    tickets: [ticket(TICKET, 'Cards widget')],
    cards,
  },
  machine: { pausedAt: null },
  layout: null,
});

const changed = (row: CardRow): StreamMessage => ({
  type: 'change',
  table: 'cards',
  op: 'update',
  id: row.id,
  row,
});

const mount = (server = fakeServer()) => ({
  ...server,
  ...render(
    <DeckProvider stream={stream} intents={server.intents}>
      <CardsWidget />
    </DeckProvider>,
  ),
});

const openCard = (scope: PageElement, n: number): PageElement =>
  find(scope, `[data-card-id="${cardId(n)}"][data-status="open"]`);

const openIds = (scope: PageElement): (string | null)[] =>
  all(scope, '[aria-label="Open cards"] article').map((article) =>
    article.getAttribute('data-card-id'),
  );

const fact = (scope: PageElement, name: string): string[] => {
  const row = find(scope, `[data-fact="${name}"]`);
  return [textOf(row, 'dt'), textOf(row, 'dd')];
};

describe('Cards widget', () => {
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

  it('registers as the cards widget', () => {
    expect(WIDGETS.get('cards')).toBe(CARDS_WIDGET);
    expect(CARDS_WIDGET.title).toBe('Cards');
  });

  it('says so when no card is open, and when nothing is answered', async () => {
    const { container, unmount } = mount();
    deliver(snapshot([]));
    expect(textOf(container, '.qd-empty')).toBe('No open cards.');
    const toggle = buttonNamed(container, 'Answered (0)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();

    await clickButton(container, 'Answered (0)');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const history = find(
      container,
      `[id="${toggle.getAttribute('aria-controls')}"]`,
    );
    expect(history.textContent).toBe('Nothing answered yet.');
    unmount();
  });

  it('shows open cards oldest first with question, ticket, checked and recommendation', () => {
    const { container, unmount } = mount();
    deliver(snapshot([card(1), askCard(4), mergeCard(2)]));
    expect(openIds(container)).toEqual([cardId(4), cardId(2), cardId(1)]);

    const ask = openCard(container, 4);
    expect(textOf(ask, '.qd-card-kind')).toBe('Question');
    expect(textOf(ask, '.qd-card-source')).toBe('Deck · mink');
    expect(textOf(ask, 'time')).toBe('4m ago');
    expect(textOf(ask, '.qd-card-ticket')).toBe('Ticket: Cards widget');
    expect(textOf(ask, '.qd-card-question')).toBe(
      'Which port should the dev server use?',
    );
    expect(fact(ask, 'checked')).toEqual([
      'Checked',
      'vite.config.ts sets none; README says 5173.',
    ]);
    expect(fact(ask, 'recommendation')).toEqual(['Recommends', '5173']);

    expect(openCard(container, 1).querySelector('.qd-card-facts')).toBeNull();
    unmount();
  });

  it('answers a free-text card through card.answer', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([askCard(1)]));
    const ask = openCard(container, 1);
    expect(find(ask, 'textarea').getAttribute('aria-label')).toBe(REPLY_LABEL);

    await typeAndSend(ask, '  use 4317  ');
    expect(sent).toEqual([
      {
        url: '/api/intents/card.answer',
        body: { project: 'deck', cardId: cardId(1), answer: 'use 4317' },
      },
    ]);
    unmount();
  });

  it('adds the lookup note to the answer when the toggle is on', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([askCard(1)]));
    const ask = openCard(container, 1);
    const toggle = find(ask, '.qd-card-lookup-toggle input');
    expect(textOf(ask, '.qd-card-lookup-toggle')).toBe(LOOKUP_LABEL);
    expect(isChecked(toggle)).toBe(false);

    check(toggle);
    expect(isChecked(toggle)).toBe(true);
    await typeAndSend(ask, '5173, it is in the README');
    expect(sent.map(({ body }) => body)).toEqual([
      {
        project: 'deck',
        cardId: cardId(1),
        answer: `5173, it is in the README\n\n${LOOKUP_NOTE}`,
      },
    ]);
    unmount();
  });

  it('offers option buttons, marks the recommended one and sends the choice', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([askCard(1, { options: ['5173', '4317'] })]));
    const ask = openCard(container, 1);
    expect(ask.querySelector('textarea')).toBeNull();
    expect(ask.querySelector('.qd-card-lookup-toggle')).toBeNull();
    expect(
      all(ask, '.qd-card-choice').map((button) => [
        button.textContent,
        button.getAttribute('data-recommended'),
      ]),
    ).toEqual([
      ['5173 (recommended)', 'true'],
      ['4317', 'false'],
    ]);

    await clickButton(ask, '4317');
    expect(sent.map(({ body }) => body)).toEqual([
      { project: 'deck', cardId: cardId(1), answer: '4317' },
    ]);
    unmount();
  });

  it('shows a sign-in card with the exact command and a Signed in answer', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([signInCard(1)]));
    const signIn = openCard(container, 1);
    expect(textOf(signIn, '.qd-card-kind')).toBe('Sign in');
    expect(textOf(signIn, '[data-fact="recommendation"] dt')).toBe('Run');
    expect(textOf(signIn, '.qd-card-command')).toBe('claude /login');
    expect(fact(signIn, 'checked')[0]).toBe('Why');
    expect(signIn.querySelector('.qd-card-lookup-toggle')).toBeNull();

    await clickButton(signIn, 'Signed in');
    expect(sent.map(({ body }) => body)).toEqual([
      { project: 'deck', cardId: cardId(1), answer: 'Signed in' },
    ]);
    unmount();
  });

  it('shows a merge card with merge and hold', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([mergeCard(1)]));
    const merge = openCard(container, 1);
    expect(textOf(merge, '.qd-card-kind')).toBe('Merge');
    expect(textOf(merge, '.qd-card-source')).toBe('Deck');
    expect(textOf(merge, '.qd-card-question')).toContain('\nmerge squash');
    expect(
      all(merge, '.qd-card-choice').map(({ textContent }) => textContent),
    ).toEqual(['merge', 'hold']);

    await clickButton(merge, 'hold');
    expect(sent.map(({ body }) => body)).toEqual([
      { project: 'deck', cardId: cardId(1), answer: 'hold' },
    ]);
    unmount();
  });

  it('declines a card through card.decline', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([mergeCard(1)]));
    await clickButton(openCard(container, 1), 'Decline');
    expect(sent).toEqual([
      {
        url: '/api/intents/card.decline',
        body: { project: 'deck', cardId: cardId(1) },
      },
    ]);
    unmount();
  });

  it('shows the refusal and keeps the card open when the server says no', async () => {
    const { container, unmount } = mount(
      fakeServer(() =>
        json(409, { error: `card ${cardId(1)} is already answered` }),
      ),
    );
    deliver(snapshot([mergeCard(1)]));
    const merge = openCard(container, 1);
    await clickButton(merge, 'merge');
    expect(textOf(merge, '[role="alert"]')).toBe(
      `card ${cardId(1)} is already answered`,
    );
    expect(isDisabled(buttonNamed(merge, 'merge'))).toBe(false);
    unmount();
  });

  it('refuses to answer a card whose project is unknown', async () => {
    const { container, sent, unmount } = mount();
    deliver(snapshot([card(1, { projectId: STRAY, options: ['yes', 'no'] })]));
    const stray = openCard(container, 1);
    await clickButton(stray, 'yes');
    expect(textOf(stray, '[role="alert"]')).toBe(NO_PROJECT_ERROR);
    expect(sent).toEqual([]);
    unmount();
  });

  it('moves an answered card into the history with its answer and lookup flag', async () => {
    const { container, unmount } = mount();
    deliver(
      snapshot([
        askCard(1),
        mergeCard(2),
        card(30, { status: 'expired', expiresAt: ago(20 * 60_000) }),
      ]),
    );
    deliver(
      changed(
        askCard(1, {
          status: 'answered',
          answer: `5173\n\n${LOOKUP_NOTE}`,
          answeredAt: ago(0),
        }),
      ),
      changed({ ...mergeCard(2), status: 'declined', answeredAt: ago(60_000) }),
    );
    expect(openIds(container)).toEqual([]);
    expect(textOf(container, '.qd-empty')).toBe('No open cards.');

    await clickButton(container, 'Answered (3)');
    const answered = all(container, '[aria-label="Answered cards"] article');
    expect(
      answered.map((article) => [
        article.getAttribute('data-card-id'),
        textOf(article, '.qd-card-answer'),
        textOf(article, 'time'),
      ]),
    ).toEqual([
      [cardId(1), 'Answered5173', 'just now'],
      [cardId(2), 'Declined', '1m ago'],
      [cardId(30), 'Expired', '20m ago'],
    ]);
    expect(answered[0]?.querySelector('.qd-card-lookup')?.textContent).toBe(
      LOOKUP_LABEL,
    );
    expect(answered[1]?.querySelector('.qd-card-lookup')).toBeNull();
    expect(answered[0]?.querySelector('button')).toBeNull();

    await clickButton(container, 'Answered (3)');
    expect(container.querySelector('[aria-label="Answered cards"]')).toBeNull();
    unmount();
  });
});
