// @vitest-environment happy-dom
import type { RuleName } from '@quarterdeck/rules';
import type { Window } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIntentClient,
  emptyTables,
  type RulesView,
} from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/deck.js';
import { WIDGETS } from '../../src/widgets/widgets.js';
import { defaultLayout } from '../../src/grid/default-layout.js';
import { RulesWidget } from '../../src/widgets/rules/rules.widget.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { choose, click } from '../grid/events.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';
import { HOME, REPO, rulesView, type RuleOverrides } from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'deck',
  name: 'Deck',
  repoPath: REPO,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  archivedAt: null,
};

type Overrides = Partial<Record<RuleName, RuleOverrides>>;

interface Harness {
  container: PageElement;
  reads: (string | null)[];
  sent: { url: string; body: unknown }[];
  setMachine: (overrides: Overrides) => void;
  unmount: () => void;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const find = (scope: PageElement, selector: string): PageElement => {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
};

const button = (scope: PageElement, label: string): PageElement => {
  const match = all(scope, 'button').find(
    ({ textContent }) => textContent === label,
  );
  if (match === undefined) throw new Error(`no ${label} button`);
  return match;
};

const isDisabled = (element: PageElement): boolean =>
  element.getAttribute('disabled') !== null;

const type = (element: PageElement, value: string) => {
  const { HTMLTextAreaElement } = (globalThis as unknown as { window: Window })
    .window;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(element, value);
    (element as unknown as EventTarget).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
  });
};

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const mount = async (
  initial: Overrides = {},
  refuse: string | null = null,
): Promise<Harness> => {
  let machine = initial;
  const reads: (string | null)[] = [];
  const sent: Harness['sent'] = [];
  const rules = (project: string | null): Promise<RulesView> => {
    reads.push(project);
    return Promise.resolve(rulesView(machine, project && REPO));
  };
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (refuse !== null) return reply(400, { error: refuse });
    return reply(200, { status: 'applied', id: null, result: {} });
  });
  const intents = createIntentClient({ fetch });
  const { container, unmount } = render(
    <DeckProvider stream={stream} intents={intents} rules={rules}>
      <RulesWidget />
    </DeckProvider>,
  );
  await flush();
  return {
    container,
    reads,
    sent,
    setMachine: (next) => {
      machine = next;
    },
    unmount,
  };
};

const pickRule = (container: PageElement, name: RuleName) => {
  choose(all(container, 'select')[0] ?? container, name);
};

const sources = (container: PageElement): Record<string, string> =>
  Object.fromEntries(
    all(container, '.qd-rules-sources tbody tr').map((row) => [
      textOf(row, 'th code'),
      textOf(row, '.qd-rules-source'),
    ]),
  );

const diffLines = (container: PageElement): string[] =>
  all(container, '.qd-diff-line').map(({ textContent }) =>
    (textContent ?? '').trimEnd(),
  );

describe('rules widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('registers as rules and starts in the tray', () => {
    expect(WIDGETS.get('rules')?.title).toBe('Rules');
    const item = defaultLayout(WIDGETS).items.find(
      ({ widget }) => widget === 'rules',
    );
    expect(item?.hidden).toBe(true);
  });

  it('shows the layers, the machine target and the tighten-only rule', async () => {
    const { container, reads, unmount } = await mount();
    expect(reads).toEqual([null]);
    const text = container.textContent ?? '';
    expect(text).toContain(
      'A project’s repo layer can only tighten permissions and mergeGate',
    );
    expect(textOf(container, '[aria-label="Machine layer"] code')).toBe(
      `${HOME}/rules.local.charter.md`,
    );
    expect(
      textOf(container, '[aria-label="Shipped defaults"] .qd-rules-tag'),
    ).toBe('read-only');
    expect(container.querySelector('[aria-label="Repo layer"]')).toBeNull();
    unmount();
  });

  it('validates as you type and only saves through the diff', async () => {
    const { container, sent, reads, setMachine, unmount } = await mount();
    pickRule(container, 'lifecycle');
    const editor = find(container, 'textarea');
    expect(editor.getAttribute('aria-label')).toBe(
      'Edit rules.local.lifecycle.json',
    );
    expect(isDisabled(button(container, 'Review changes'))).toBe(true);

    type(editor, '{ "stuckAfterMinutes": "soon" }');
    expect(textOf(container, '[role="alert"]')).toContain(
      `${HOME}/rules.local.lifecycle.json`,
    );
    expect(isDisabled(button(container, 'Review changes'))).toBe(true);

    const content = '{\n  "stuckAfterMinutes": 45\n}\n';
    type(editor, content);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(sources(container)).toMatchObject({
      stuckAfterMinutes: 'machine',
      autoEndSettleSeconds: 'defaults',
    });

    click(button(container, 'Review changes'));
    expect(diffLines(container)).toEqual([
      '+ {',
      '+   "stuckAfterMinutes": 45',
      '+ }',
    ]);
    expect(sent).toEqual([]);

    setMachine({ lifecycle: { machine: content } });
    click(button(container, 'Save'));
    await flush();
    expect(sent).toEqual([
      {
        url: '/api/intents/rules.write',
        body: { scope: 'machine', name: 'lifecycle', content },
      },
    ]);
    expect(reads).toEqual([null, null]);
    expect(textOf(container, '[role="status"]')).toBe(
      `Saved ${HOME}/rules.local.lifecycle.json`,
    );
    expect(container.querySelector('[aria-label="Review changes"]')).toBeNull();
    unmount();
  });

  it('removes the machine file only after showing what goes', async () => {
    const { container, sent, unmount } = await mount({
      naming: { machine: '{ "theme": "birds" }\n' },
    });
    pickRule(container, 'naming');
    click(button(container, 'Remove file'));
    expect(diffLines(container)).toEqual(['- { "theme": "birds" }']);
    click(button(container, 'Remove'));
    await flush();
    expect(sent).toEqual([
      {
        url: '/api/intents/rules.reset',
        body: { scope: 'machine', name: 'naming' },
      },
    ]);
    unmount();
  });

  it('keeps the review open and shows the server refusal', async () => {
    const { container, unmount } = await mount({}, 'nope: refused');
    pickRule(container, 'models');
    type(find(container, 'textarea'), '{ "builder": { "runtime": "claude" } }');
    click(button(container, 'Review changes'));
    click(button(container, 'Save'));
    await flush();
    expect(
      textOf(container, '[aria-label="Review changes"] [role="alert"]'),
    ).toBe('nope: refused');
    unmount();
  });

  it('shows a project’s repo layer read-only and credits its values', async () => {
    const { container, reads, unmount } = await mount({
      lifecycle: { repo: '{ "stuckAfterMinutes": 90 }' },
    });
    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'snapshot',
        cursor: 0,
        tables: { ...emptyTables(), projects: [PROJECT] },
      });
    });
    choose(all(container, 'select')[1] ?? container, 'deck');
    await flush();
    expect(reads).toEqual([null, 'deck']);
    pickRule(container, 'lifecycle');
    const repo = find(container, '[aria-label="Repo layer"]');
    expect(textOf(repo, '.qd-rules-tag')).toBe('read-only');
    expect(textOf(repo, 'code')).toBe(
      `${REPO}/.quarterdeck/rules.local.lifecycle.json`,
    );
    expect(repo.querySelector('textarea')).toBeNull();
    expect(sources(container)['stuckAfterMinutes']).toBe('repo');
    unmount();
  });

  it('says plainly that repo permissions are decided on their own', async () => {
    const { container, unmount } = await mount({
      permissions: { repo: '{ "default": "deny" }' },
    });
    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'snapshot',
        cursor: 0,
        tables: { ...emptyTables(), projects: [PROJECT] },
      });
    });
    choose(all(container, 'select')[1] ?? container, 'deck');
    await flush();
    pickRule(container, 'permissions');
    expect(textOf(container, '[aria-label="Repo layer"]')).toContain(
      'the stricter answer wins',
    );
    expect(all(container, '.qd-rules-sources .qd-rules-tag').length).toBe(
      all(container, '.qd-rules-sources tbody tr').length,
    );
    unmount();
  });
});
