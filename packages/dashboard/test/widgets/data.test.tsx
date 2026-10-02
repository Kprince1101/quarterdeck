// @vitest-environment happy-dom
import type { DataPage, DataSummary } from '@quarterdeck/server/intents';
import type { StreamMessage } from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/deck.js';
import { DataWidget } from '../../src/widgets/data/data.widget.js';
import {
  formatCell,
  pageView,
  pathViews,
} from '../../src/widgets/data/data-view.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { click } from '../grid/events.js';
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
      },
    ],
  },
  machine: { pausedAt: null },
};

const reply = (intent: string, result: unknown): Response =>
  Response.json({ intent, status: 'applied', id: null, result });

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
  const deliver = async (message: StreamMessage) => {
    act(() => {
      FakeSocket.opened[0]?.deliver(message);
    });
    await settle();
  };
  return { ...rendered, deliver };
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

  it('shows the server error instead of the tables', async () => {
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

  it('labels where each path lives', () => {
    expect(pathViews(SUMMARY.paths).map(({ scope }) => scope)).toEqual([
      'This project',
      'This machine',
    ]);
  });
});
