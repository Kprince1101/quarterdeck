// @vitest-environment happy-dom
import type { SnapshotTables } from '@quarterdeck/server/stream-schema';
import type { HTMLTextAreaElement as HappyTextArea, Window } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient, emptyTables } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/deck.js';
import { NotebookWidget } from '../../../src/widgets/notebook/notebook.widget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { click } from '../../grid/events.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import {
  ADD_ID,
  ENTRY_ID,
  PINNED_ID,
  RETIRE_ID,
  UPDATE_ID,
  notebookTables,
  proposal,
} from './fixtures.js';

interface Sent {
  url: string;
  body: unknown;
}

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const replyWith = (status: number, body: object, sent: Sent[]) =>
  vi.fn<typeof fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });

const mount = (tables: SnapshotTables, status = 200, reply: object = {}) => {
  const sent: Sent[] = [];
  const intents = createIntentClient({
    baseUrl: 'http://deck.test',
    fetch: replyWith(status, reply, sent),
  });
  const rendered = render(
    <DeckProvider stream={stream} intents={intents}>
      <NotebookWidget />
    </DeckProvider>,
  );
  act(() => {
    FakeSocket.opened[0]?.deliver({ type: 'snapshot', cursor: 0, tables });
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

const card = (scope: PageElement, id: string) =>
  find(scope, `[data-proposal-id="${id}"]`);

const button = (scope: PageElement, name: string): PageElement => {
  const found = all(scope, 'button').find(
    ({ textContent }) => textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};

const names = (scope: PageElement): (string | null)[] =>
  all(scope, 'button').map(({ textContent }) => textContent);

const type = (scope: PageElement, text: string) => {
  const area = find(scope, 'textarea') as unknown as HappyTextArea;
  const win = (globalThis as unknown as { window: Window }).window;
  act(() => {
    const prototype = Object.getPrototypeOf(area) as object;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(area, text);
    area.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
};

const diffOf = (scope: PageElement): string[] =>
  all(scope, '.qd-notebook-diff li').map(
    (line) => `${line.getAttribute('data-diff')}:${line.textContent}`,
  );

describe('notebook widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('registers as the notebook widget', () => {
    expect(WIDGETS.get('notebook')).toMatchObject({
      title: 'Notebook',
      component: NotebookWidget,
    });
  });

  it('says so when there is nothing to show', () => {
    const { container, unmount } = mount(emptyTables());
    expect(textOf(container, '[aria-label="Proposals"]')).toContain(
      'No open proposals.',
    );
    expect(textOf(container, '[aria-label="Active entries"]')).toContain(
      'The notebook is empty.',
    );
    unmount();
  });

  it('shows every open proposal in full', () => {
    const { container, unmount } = mount(notebookTables());
    const add = card(container, ADD_ID);
    expect(add.getAttribute('aria-label')).toBe('Add proposal');
    expect(textOf(add, '.qd-notebook-text')).toBe('Ask before deploying.');
    expect(textOf(add, '.qd-notebook-flag')).toBe('pinned');
    expect(names(add)).toEqual(['Approve', 'Edit', 'Reject']);

    expect(diffOf(card(container, UPDATE_ID))).toEqual([
      'same: Run the tests.',
      'removed:-Use npm.',
      'added:+Use npm ci.',
    ]);

    const retire = card(container, RETIRE_ID);
    expect(textOf(retire, '.qd-notebook-retired')).toBe('Never merge.');
    expect(textOf(retire, '.qd-notebook-note')).toBe('No longer true.');
    expect(names(retire)).toEqual(['Approve', 'Reject']);
    unmount();
  });

  it('approves and rejects through notebook.decide', async () => {
    const { container, sent, unmount } = mount(notebookTables());
    click(button(card(container, ADD_ID), 'Approve'));
    click(button(card(container, RETIRE_ID), 'Reject'));
    await settle();
    expect(sent).toEqual([
      {
        url: 'http://deck.test/api/intents/notebook.decide',
        body: { project: 'deck', proposalId: ADD_ID, decision: 'accepted' },
      },
      {
        url: 'http://deck.test/api/intents/notebook.decide',
        body: { project: 'deck', proposalId: RETIRE_ID, decision: 'rejected' },
      },
    ]);
    unmount();
  });

  it('edits an update against the text it replaces, then approves the edit', async () => {
    const { container, sent, unmount } = mount(notebookTables());
    const update = () => card(container, UPDATE_ID);
    click(button(update(), 'Edit'));
    expect((find(update(), 'textarea') as unknown as HappyTextArea).value).toBe(
      'Run the tests.\nUse npm ci.',
    );
    expect(names(update())).toEqual(['Approve edit', 'Cancel']);

    type(update(), 'Run every test.\nUse npm.');
    expect(diffOf(update())).toEqual([
      'removed:-Run the tests.',
      'added:+Run every test.',
      'same: Use npm.',
    ]);

    click(button(update(), 'Approve edit'));
    await settle();
    expect(sent.map(({ body }) => body)).toEqual([
      {
        project: 'deck',
        proposalId: UPDATE_ID,
        decision: 'accepted',
        body: 'Run every test.\nUse npm.',
      },
    ]);
    expect(update().querySelector('textarea')).toBeNull();
    unmount();
  });

  it('cancels an edit and refuses to approve an empty one', () => {
    const { container, sent, unmount } = mount(notebookTables());
    const add = () => card(container, ADD_ID);
    click(button(add(), 'Edit'));
    expect(add().querySelector('.qd-notebook-text')).toBeNull();
    type(add(), '   ');
    expect(button(add(), 'Approve edit').getAttribute('disabled')).toBe('');
    click(button(add(), 'Cancel'));
    expect(textOf(add(), '.qd-notebook-text')).toBe('Ask before deploying.');
    expect(sent).toEqual([]);
    unmount();
  });

  it('lists active entries pinned first and toggles the pin', async () => {
    const { container, sent, unmount } = mount(notebookTables());
    const entries = all(container, '[data-entry-id]');
    expect(entries.map((row) => row.getAttribute('data-entry-id'))).toEqual([
      PINNED_ID,
      ENTRY_ID,
    ]);
    expect(
      entries.map((row) =>
        find(row, '.qd-notebook-pin').getAttribute('aria-pressed'),
      ),
    ).toEqual(['true', 'false']);

    entries.forEach((row) => {
      click(find(row, '.qd-notebook-pin'));
    });
    await settle();
    expect(sent).toEqual([
      {
        url: 'http://deck.test/api/intents/notebook.pin',
        body: { project: 'deck', entryId: PINNED_ID, pinned: false },
      },
      {
        url: 'http://deck.test/api/intents/notebook.pin',
        body: { project: 'deck', entryId: ENTRY_ID, pinned: true },
      },
    ]);
    unmount();
  });

  it('shows a refusal from the server and stays decidable', async () => {
    const { container, unmount } = mount(notebookTables(), 409, {
      error: `notebook entry ${ENTRY_ID} is retired`,
    });
    click(button(card(container, UPDATE_ID), 'Approve'));
    await settle();
    expect(textOf(card(container, UPDATE_ID), '[role="alert"]')).toBe(
      `notebook entry ${ENTRY_ID} is retired`,
    );
    expect(
      button(card(container, UPDATE_ID), 'Approve').getAttribute('disabled'),
    ).toBeNull();
    unmount();
  });

  it('drops a proposal once the stream says it was decided', () => {
    const { container, unmount } = mount(notebookTables());
    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'change',
        table: 'notebook_proposals',
        op: 'update',
        id: ADD_ID,
        row: proposal(ADD_ID, 'add', {
          body: 'Ask before deploying.',
          status: 'accepted',
          decidedAt: '2026-10-01T12:01:00.000Z',
        }),
      });
    });
    expect(
      container.querySelector(`[data-proposal-id="${ADD_ID}"]`),
    ).toBeNull();
    expect(all(container, '[data-proposal-id]')).toHaveLength(2);
    unmount();
  });
});
