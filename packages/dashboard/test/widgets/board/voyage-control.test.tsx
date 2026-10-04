// @vitest-environment happy-dom
import type { SnapshotTables } from '@quarterdeck/server/stream-schema';
import type { HTMLInputElement as HappyInput, Window } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/DeckProvider.js';
import { VoyageControl } from '../../../src/widgets/board/VoyageControl.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { click } from '../../grid/events.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import {
  BUSY_BUILDER_ID,
  SITE_ID,
  projectTables,
  voyage,
} from '../project/fixtures.js';

interface Sent {
  url: string;
  body: unknown;
}

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const INTENTS_URL = 'http://deck.test/api/intents/';

const mount = (tables: SnapshotTables, status = 200, reply: object = {}) => {
  const sent: Sent[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  });
  const intents = createIntentClient({ baseUrl: 'http://deck.test', fetch });
  const rendered = render(
    <DeckProvider stream={stream} intents={intents}>
      <VoyageControl />
    </DeckProvider>,
  );
  act(() => {
    FakeSocket.opened[0]?.deliver({
      type: 'snapshot',
      cursor: 0,
      tables,
      machine: { pausedAt: null },
      layout: null,
    });
  });
  return { ...rendered, sent };
};

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const find = (scope: PageElement, selector: string): PageElement => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
};

const section = (scope: PageElement) =>
  find(scope, 'section[aria-label="Voyage"]');

const button = (scope: PageElement, name: string): PageElement => {
  const found = all(scope, 'button').find(
    ({ textContent }) => textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};

const names = (scope: PageElement): (string | null)[] =>
  all(scope, 'button').map(({ textContent }) => textContent);

const isDisabled = (element: PageElement): boolean =>
  element.getAttribute('disabled') !== null;

const type = (scope: PageElement, text: string) => {
  const field = find(
    scope,
    'input[aria-label="Voyage goal"]',
  ) as unknown as HappyInput;
  const win = (globalThis as unknown as { window: Window }).window;
  act(() => {
    const prototype = Object.getPrototypeOf(field) as object;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text);
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
};

const sentTo = (sent: Sent[]) =>
  sent.map(({ url, body }) => [url.slice(INTENTS_URL.length), body]);

const twoProjects = (): SnapshotTables => {
  const tables = projectTables();
  tables.voyages = tables.voyages.map((row) => ({
    ...row,
    projects: ['deck', 'site'],
  }));
  return tables;
};

describe('the Board’s voyage control', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('shows the open voyage with every project in it, and ends it', async () => {
    const { container, sent, unmount } = mount(twoProjects());
    expect(textOf(section(container), '.qd-board-voyage-label')).toBe(
      'Voyage 2 · active',
    );
    expect(textOf(section(container), '.qd-board-voyage-goal')).toBe(
      'Ship the project widget',
    );
    expect(
      all(container, '[data-voyage-project]').map((item) =>
        item.getAttribute('data-voyage-project'),
      ),
    ).toEqual(['deck', 'site']);
    expect(names(section(container))).toEqual([
      'Kill',
      'Kill',
      'End voyage',
      'Kill all',
    ]);
    click(button(section(container), 'End voyage'));
    await settle();
    expect(sentTo(sent)).toEqual([['voyage.end', { voyage: 2 }]]);
    unmount();
  });

  it('kills one project’s builders and leaves the voyage', async () => {
    const { container, sent, unmount } = mount(twoProjects());
    click(find(container, '[data-voyage-project="site"] button'));
    await settle();
    expect(sentTo(sent)).toEqual([['project.kill', { project: 'site' }]]);
    expect(
      find(container, '[data-voyage-project="site"] button').getAttribute(
        'aria-label',
      ),
    ).toBe('Kill site’s builders');
    unmount();
  });

  it('sends nothing on one click of Kill all and asks with the reopen count', async () => {
    const { container, sent, unmount } = mount(projectTables());
    const voyageSection = () => section(container);
    const confirm = 'Kill all? This ends the voyage and reopens 3 tickets';
    click(button(voyageSection(), 'Kill all'));
    await settle();
    expect(sent).toEqual([]);
    expect(names(voyageSection())).toEqual(['Kill', confirm, 'Cancel']);
    click(button(voyageSection(), 'Cancel'));
    expect(sent).toEqual([]);

    click(button(voyageSection(), 'Kill all'));
    click(button(voyageSection(), confirm));
    await settle();
    expect(sentTo(sent)).toEqual([['voyage.kill', { voyage: 2 }]]);
    unmount();
  });

  it('counts the reopened tickets from the stream', () => {
    const tables = projectTables();
    tables.tickets = tables.tickets.filter(
      ({ assigneeId }) => assigneeId === BUSY_BUILDER_ID,
    );
    const { container, unmount } = mount(tables);
    click(button(section(container), 'Kill all'));
    expect(names(section(container))[1]).toBe(
      'Kill all? This ends the voyage and reopens 1 ticket',
    );
    unmount();
  });

  it('starts a voyage across every project with a goal once there is one', async () => {
    const { container, sent, unmount } = mount(emptyTables());
    const voyageSection = () => section(container);
    expect(textOf(voyageSection(), '.qd-empty')).toBe('No voyage running.');
    expect(isDisabled(button(voyageSection(), 'Start voyage'))).toBe(true);
    type(voyageSection(), '   ');
    expect(isDisabled(button(voyageSection(), 'Start voyage'))).toBe(true);
    type(voyageSection(), 'Launch the site');
    click(button(voyageSection(), 'Start voyage'));
    await settle();
    expect(sentTo(sent)).toEqual([
      ['voyage.start', { goal: 'Launch the site' }],
    ]);
    expect(
      (find(voyageSection(), 'input') as unknown as HappyInput).value,
    ).toBe('');
    unmount();
  });

  it('follows the stream when a voyage starts', () => {
    const { container, unmount } = mount(emptyTables());
    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'change',
        table: 'voyages',
        op: 'insert',
        id: '00000000-0000-4000-8000-0000000000b9',
        row: voyage('00000000-0000-4000-8000-0000000000b9', 1, {
          projectId: SITE_ID,
          status: 'planning',
          goal: 'Launch',
          projects: ['site'],
        }),
      });
    });
    expect(names(section(container))).toEqual([
      'Kill',
      'End voyage',
      'Kill all',
    ]);
    unmount();
  });

  it('shows a refusal from the server in the control', async () => {
    const { container, unmount } = mount(projectTables(), 409, {
      error: 'voyage 2 is not running',
    });
    click(button(section(container), 'End voyage'));
    await settle();
    expect(textOf(section(container), '[role="alert"]')).toBe(
      'voyage 2 is not running',
    );
    expect(isDisabled(button(section(container), 'End voyage'))).toBe(false);
    unmount();
  });
});
