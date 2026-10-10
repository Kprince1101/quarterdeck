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
import { DeckProvider } from '../../src/deck/DeckProvider.js';
import { WIDGETS } from '../../src/widgets/widgets.js';
import { defaultLayout } from '../../src/grid/default-layout.js';
import { RulesWidget } from '../../src/widgets/rules/RulesWidget.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { choose, click } from '../grid/events.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';
import {
  HOME,
  HOUSE_DIR,
  REPO,
  rulesView,
  type RuleOverrides,
} from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'deck',
  name: 'Deck',
  repoPath: REPO,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  archivedAt: null,
  pausedAt: null,
  tracker: null,
  publishes: null,
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
      'A project’s repo layer can only tighten permissions, mergeGate, autoEndSettleSeconds and budget.window',
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
        machine: { pausedAt: null },
        layout: null,
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

  it('warns about git * and bash * but not git status *', async () => {
    const { container, unmount } = await mount();
    pickRule(container, 'permissions');
    expect(container.querySelector('[aria-label="Shell warnings"]')).toBeNull();

    const rules = ['git status *', 'git *', 'bash *'].map((pattern) => ({
      kind: 'execute',
      pattern,
      decision: 'allow',
    }));
    type(find(container, 'textarea'), JSON.stringify({ rules }));
    expect(
      all(container, '[aria-label="Shell warnings"] li').map(
        ({ textContent }) => textContent,
      ),
    ).toEqual([
      'execute allow "git *" permits git with any arguments, which can run any code.',
      'execute allow "bash *" permits bash, which can run any code.',
    ]);

    type(find(container, 'textarea'), JSON.stringify({ rules: [rules[0]] }));
    expect(container.querySelector('[aria-label="Shell warnings"]')).toBeNull();
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
        machine: { pausedAt: null },
        layout: null,
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

  it('shows the active profile, the files it reads and the file picking writes', async () => {
    const { container, unmount } = await mount();
    const panel = find(container, '[aria-label="Rules profile"]');
    expect(textOf(panel, 'h3')).toBe('Profile: default');
    expect(panel.textContent).toContain('Chosen by the shipped default.');
    expect(panel.textContent).toContain(
      `Picking a profile or a level writes ${HOME}/rules.local.profile.json`,
    );
    expect(all(panel, 'option').map(({ textContent }) => textContent)).toEqual([
      'default (shipped)',
      'house (this machine)',
    ]);
    expect(panel.textContent).toContain('This profile sets no rule levels.');
    unmount();
  });

  it('drafts the profile layer when a profile is picked, and saves it only through the diff', async () => {
    const { container, sent, unmount } = await mount();
    const panel = find(container, '[aria-label="Rules profile"]');
    choose(find(panel, 'select'), 'house');

    expect(find(container, 'textarea').getAttribute('aria-label')).toBe(
      'Edit rules.local.profile.json',
    );
    expect(
      all(container, '[aria-label="Files the profile reads"] code').map(
        ({ textContent }) => textContent,
      ),
    ).toEqual([`${HOUSE_DIR}/profile.json`, '/docs/house-standards.md']);
    expect(
      all(container, '[aria-label="Rule levels"] code').map(
        ({ textContent }) => textContent,
      ),
    ).toEqual(['max-lines', 'no-ternary']);

    choose(find(container, 'select[name="max-lines"]'), '0');
    click(button(container, 'Review changes'));
    expect(diffLines(container)).toEqual([
      '+ {',
      '+   "profile": "house",',
      '+   "levels": {',
      '+     "max-lines": 0',
      '+   }',
      '+ }',
    ]);
    expect(textOf(container, '[aria-label="Rule levels"] .qd-rules-tag')).toBe(
      'local',
    );
    click(button(container, 'Save'));
    await flush();
    expect(sent).toEqual([
      {
        url: '/api/intents/rules.write',
        body: {
          scope: 'machine',
          name: 'profile',
          content:
            '{\n  "profile": "house",\n  "levels": {\n    "max-lines": 0\n  }\n}\n',
        },
      },
    ]);
    unmount();
  });

  it('shows the profile the machine already chose', async () => {
    const { container, unmount } = await mount({
      profile: { machine: '{ "profile": "house" }' },
    });
    const panel = find(container, '[aria-label="Rules profile"]');
    expect(textOf(panel, 'h3')).toBe('Profile: house');
    expect(panel.textContent).toContain('Chosen by this machine.');
    expect(panel.textContent).toContain('The house style.');
    unmount();
  });
});
