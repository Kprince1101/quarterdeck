// @vitest-environment happy-dom
import type {
  DataPage,
  DataSummary,
  WipeResult,
} from '@quarterdeck/server/intents';
import type { StreamMessage } from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/DeckProvider.js';
import { DataWidget } from '../../src/widgets/data/DataWidget.js';
import {
  formatCell,
  pageView,
  pathViews,
  wipeSummary,
} from '../../src/widgets/data/data-view.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { click } from '../grid/events.js';
import { dom, typeInto, type DomElement } from '../primitives/dom.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-01T12:00:00.000Z';
const NOTES = 30;

const SUMMARY: DataSummary = {
  backend: 'pglite',
  tables: [
    { table: 'projects', rows: 1 },
    { table: 'notebook', rows: NOTES },
  ],
  paths: [
    {
      label: 'Postgres data',
      path: '/home/me/.quarterdeck/deck/pg',
      kind: 'directory',
      scope: 'project',
      exists: true,
    },
    {
      label: 'Ticket plugins',
      path: '/home/me/.quarterdeck/plugins',
      kind: 'directory',
      scope: 'machine',
      exists: false,
    },
  ],
};

const notebookPage = (offset: number, limit: number): DataPage => {
  const count = Math.max(0, Math.min(limit, NOTES - offset));
  return {
    table: 'notebook',
    offset,
    limit,
    total: NOTES,
    columns: ['id', 'body', 'pinned'],
    rows: Array.from({ length: count }, (_, at) => [
      `note-${offset + at}`,
      `note ${NOTES - offset - at}`,
      false,
    ]),
  };
};

const SNAPSHOT: StreamMessage = {
  type: 'snapshot',
  cursor: 0,
  tables: {
    ...emptyTables(),
    projects: [
      {
        id: PROJECT_ID,
        slug: 'deck',
        name: 'Deck',
        repoPath: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        archivedAt: null,
        pausedAt: null,
        tracker: null,
        publishes: null,
      },
    ],
  },
  machine: { pausedAt: null },
  layout: null,
};

const reply = (intent: string, result: unknown): Response =>
  Response.json({ intent, status: 'applied', id: null, result });

const WIPED: Record<string, WipeResult> = {
  'wipe.project': {
    wiped: ['deck'],
    stopped: [
      { project: 'deck', agent: 'wren' },
      { project: 'deck', agent: 'lark' },
    ],
  },
  'wipe.all': { wiped: ['deck', 'yard'], stopped: [] },
};

const fakeServer = () =>
  vi.fn<typeof fetch>((url, init) => {
    const intent = String(url).split('/').at(-1) ?? '';
    const body = JSON.parse(String(init?.body)) as {
      offset?: number;
      limit?: number;
    };
    if (intent === 'data.summary') {
      return Promise.resolve(reply(intent, SUMMARY));
    }
    const wiped = WIPED[intent];
    if (wiped !== undefined) return Promise.resolve(reply(intent, wiped));
    return Promise.resolve(
      reply(intent, notebookPage(body.offset ?? 0, body.limit ?? 25)),
    );
  });

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const buttonNamed = (container: PageElement, name: string): PageElement => {
  const button = all(container, 'button').find(
    ({ textContent }) => textContent?.startsWith(name) ?? false,
  );
  if (button === undefined) throw new Error(`no ${name} button`);
  return button;
};

const wipeForm = (container: PageElement, label: string) => {
  const form = container.querySelector(`form[aria-label="${label}"]`);
  const field = form?.querySelector('input');
  const button = form?.querySelector('button');
  if (!form || !field || !button) throw new Error(`no ${label} form`);
  return {
    form,
    button,
    isDisabled: () => button.getAttribute('disabled') !== null,
    type: (value: string) => typeInto(field as unknown as DomElement, value),
    value: () => (field as unknown as { value: string }).value,
  };
};

const sentIntents = (server: ReturnType<typeof fakeServer>) =>
  server.mock.calls.map(([url, init]) => ({
    intent: String(url).split('/').at(-1),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  }));

const mount = (server: ReturnType<typeof fakeServer>) => {
  const intents = createIntentClient({ fetch: server });
  const rendered = render(
    <DeckProvider
      stream={{ url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET }}
      intents={intents}
    >
      <DataWidget />
    </DeckProvider>,
  );
  const attached = rendered.container as unknown as DomElement;
  dom().document.body.append(attached);
  const deliver = async (message: StreamMessage) => {
    act(() => {
      FakeSocket.opened[0]?.deliver(message);
    });
    await settle();
  };
  const unmount = () => {
    rendered.unmount();
    attached.remove();
  };
  return { container: rendered.container, deliver, unmount };
};

describe('Data widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('waits for the project before asking the server anything', () => {
    const server = fakeServer();
    const { container, unmount } = mount(server);
    expect(container.textContent).toBe('Waiting for the project.');
    expect(server).not.toHaveBeenCalled();
    unmount();
  });

  it('lists every table with its row count and every path on disk', async () => {
    const server = fakeServer();
    const { container, deliver, unmount } = mount(server);
    await deliver(SNAPSHOT);

    expect(sentIntents(server)).toEqual([
      { intent: 'data.summary', body: { project: 'deck' } },
    ]);
    expect(
      all(container, '.qd-data-tables button').map(
        ({ textContent }) => textContent,
      ),
    ).toEqual(['projects1', 'notebook30']);
    const paths = all(container, '.qd-data-paths li');
    expect(paths.map((path) => path.getAttribute('data-exists'))).toEqual([
      'true',
      'false',
    ]);
    expect(textOf(container, '.qd-data-paths code')).toBe(
      '/home/me/.quarterdeck/deck/pg',
    );
    expect(paths[1]?.textContent).toContain('not created yet');
    unmount();
  });

  it('pages through the rows of the table picked', async () => {
    const server = fakeServer();
    const { container, deliver, unmount } = mount(server);
    await deliver(SNAPSHOT);
    expect(container.textContent).toContain('Pick a table');

    click(buttonNamed(container, 'notebook'));
    await settle();
    expect(textOf(container, '.qd-data-range')).toBe('1–25 of 30');
    expect(
      all(container, '.qd-data-rows th').map(({ textContent }) => textContent),
    ).toEqual(['id', 'body', 'pinned']);
    expect(textOf(container, '.qd-data-rows tbody td:nth-child(2)')).toBe(
      'note 30',
    );
    expect(buttonNamed(container, 'Previous').getAttribute('disabled')).toBe(
      '',
    );

    click(buttonNamed(container, 'Next'));
    await settle();
    expect(textOf(container, '.qd-data-range')).toBe('26–30 of 30');
    expect(all(container, '.qd-data-rows tbody tr')).toHaveLength(5);
    expect(buttonNamed(container, 'Next').getAttribute('disabled')).toBe('');

    click(buttonNamed(container, 'Previous'));
    await settle();
    expect(textOf(container, '.qd-data-range')).toBe('1–25 of 30');
    expect(
      sentIntents(server)
        .filter(({ intent }) => intent === 'data.rows')
        .map(({ body }) => body['offset']),
    ).toEqual([0, 25, 0]);
    unmount();
  });

  it('counts again when the stream moves or Refresh is pressed', async () => {
    const server = fakeServer();
    const { container, deliver, unmount } = mount(server);
    await deliver(SNAPSHOT);
    await deliver({
      type: 'event',
      event: {
        id: 1,
        projectId: PROJECT_ID,
        agentId: null,
        ticketId: null,
        kind: 'notebook.add',
        payload: {},
        createdAt: STAMP,
      },
    });
    click(buttonNamed(container, 'Refresh'));
    await settle();
    expect(
      sentIntents(server).filter(({ intent }) => intent === 'data.summary'),
    ).toHaveLength(3);
    unmount();
  });

  it('shows the server error instead of the tables, and why a wipe failed', async () => {
    const server = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          { error: 'project deck does not exist' },
          { status: 404 },
        ),
      ),
    );
    const { container, deliver, unmount } = mount(server);
    await deliver(SNAPSHOT);
    expect(textOf(container, '.qd-data-error')).toBe(
      'project deck does not exist',
    );
    expect(container.querySelector('.qd-data-tables')).toBeNull();

    const wipe = wipeForm(container, 'Wipe project');
    wipe.type('deck');
    click(wipe.button);
    await settle();
    expect(textOf(container, '[role="alert"]')).toBe(
      'project deck does not exist',
    );
    expect(wipe.value()).toBe('deck');
    unmount();
  });

  it('wipes the project only once its slug is typed', async () => {
    const server = fakeServer();
    const { container, deliver, unmount } = mount(server);
    await deliver(SNAPSHOT);
    const wipe = wipeForm(container, 'Wipe project');
    expect(wipe.form.textContent).toContain('Type deck to confirm');
    expect(wipe.isDisabled()).toBe(true);

    wipe.type('dec');
    expect(wipe.isDisabled()).toBe(true);
    wipe.type('deck');
    expect(wipe.isDisabled()).toBe(false);
    click(wipe.button);
    await settle();

    expect(
      sentIntents(server).filter(({ intent }) => intent?.startsWith('wipe.')),
    ).toEqual([
      { intent: 'wipe.project', body: { project: 'deck', confirm: 'deck' } },
    ]);
    expect(textOf(wipe.form, '[role="status"]')).toBe(
      'Wiped deck. Stopped wren (deck), lark (deck) first.',
    );
    expect(wipe.value()).toBe('');
    expect(wipe.isDisabled()).toBe(true);
    expect(
      sentIntents(server).filter(({ intent }) => intent === 'data.summary'),
    ).toHaveLength(2);
    unmount();
  });

  it('wipes everything only once "wipe everything" is typed', async () => {
    const server = fakeServer();
    const { container, deliver, unmount } = mount(server);
    await deliver(SNAPSHOT);
    const wipe = wipeForm(container, 'Wipe everything');

    wipe.type('deck');
    expect(wipe.isDisabled()).toBe(true);
    wipe.type('wipe everything');
    click(wipe.button);
    await settle();

    expect(
      sentIntents(server).filter(({ intent }) => intent?.startsWith('wipe.')),
    ).toEqual([{ intent: 'wipe.all', body: { confirm: 'wipe everything' } }]);
    expect(textOf(wipe.form, '[role="status"]')).toBe('Wiped deck, yard.');
    unmount();
  });
});

describe('data view', () => {
  it('formats every kind of cell', () => {
    expect(
      [null, 'text', 3, true, { a: 1 }, ['x']].map((value) =>
        formatCell(value),
      ),
    ).toEqual(['null', 'text', '3', 'true', '{"a":1}', '["x"]']);
  });

  it('describes empty and past-the-end pages', () => {
    const empty = pageView({
      table: 'cards',
      offset: 0,
      limit: 25,
      total: 0,
      columns: [],
      rows: [],
    });
    expect(empty).toMatchObject({
      range: 'No rows',
      canPrevious: false,
      canNext: false,
    });
    const past = pageView({ ...notebookPage(50, 25) });
    expect(past.range).toBe('Past the last of 30 rows');
    expect(past.canPrevious).toBe(true);
  });

  it('sums up a wipe that found nothing', () => {
    expect(wipeSummary({ wiped: [], stopped: [] })).toBe('Wiped nothing.');
  });

  it('labels where each path lives', () => {
    expect(pathViews(SUMMARY.paths).map(({ scope }) => scope)).toEqual([
      'This project',
      'This machine',
    ]);
  });
});
