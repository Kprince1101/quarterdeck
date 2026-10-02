// @vitest-environment happy-dom
import type { SnapshotTables } from '@quarterdeck/server/stream-schema';
import type { HTMLInputElement as HappyInput, Window } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIntentClient,
  emptyTables,
  type RulesView,
} from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/deck.js';
import PROJECT_WIDGET, {
  ProjectWidget,
} from '../../../src/widgets/project/project.widget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { choose, click } from '../../grid/events.js';
import { HOME, REPO, rulesView } from '../../rules/fixtures.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import {
  DECK_ID,
  IDLE_BUILDER_ID,
  IDLE_REVIEWER_ID,
  OLD_ID,
  ROUND_ID,
  SITE_ID,
  projectTables,
  round,
} from './fixtures.js';

interface Sent {
  url: string;
  body: unknown;
}

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const INTENTS_URL = 'http://deck.test/api/intents/';

interface Lifecycle {
  machine?: string;
  repo?: string;
}

const repoDirOf = ({ repo }: Lifecycle): string | null => {
  if (repo === undefined) return null;
  return REPO;
};

const fakeRules = (lifecycle: Lifecycle) => {
  const layers = { ...lifecycle };
  const asked: (string | null)[] = [];
  const read = (project: string | null): Promise<RulesView> => {
    asked.push(project);
    const view = rulesView({ lifecycle: { ...layers } }, repoDirOf(layers));
    return Promise.resolve(view);
  };
  const write = (body: unknown) => {
    layers.machine = (body as { content: string }).content;
  };
  return { asked, read, write };
};

const mount = (
  tables: SnapshotTables,
  status = 202,
  reply: object = {},
  lifecycle: Lifecycle = {},
) => {
  const sent: Sent[] = [];
  const rules = fakeRules(lifecycle);
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    sent.push({ url: String(url), body });
    if (String(url).endsWith('rules.write') && status < 300) rules.write(body);
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  });
  const intents = createIntentClient({ baseUrl: 'http://deck.test', fetch });
  const rendered = render(
    <DeckProvider stream={stream} intents={intents} rules={rules.read}>
      <ProjectWidget />
    </DeckProvider>,
  );
  act(() => {
    FakeSocket.opened[0]?.deliver({ type: 'snapshot', cursor: 0, tables });
  });
  return { ...rendered, sent, asked: rules.asked };
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

const section = (scope: PageElement, label: string) =>
  find(scope, `section[aria-label="${label}"]`);

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
  const input = find(scope, 'input[aria-label="Round goal"]');
  const field = input as unknown as HappyInput;
  const win = (globalThis as unknown as { window: Window }).window;
  act(() => {
    const prototype = Object.getPrototypeOf(field) as object;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text);
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
};

const pickProject = (scope: PageElement, id: string) => {
  choose(find(scope, '.qd-project-picker select'), id);
};

const sentTo = (sent: Sent[]) =>
  sent.map(({ url, body }) => [url.slice(INTENTS_URL.length), body]);

const gate = (scope: PageElement, key: string) =>
  find(scope, `[data-gate="${key}"]`);

const gates = (scope: PageElement) =>
  all(scope, '[data-gate]').map((toggle) => {
    const box = find(toggle, 'input') as unknown as HappyInput;
    return [toggle.textContent, box.checked, box.disabled];
  });

const writtenContent = (sent: Sent[]): string => {
  const write = sent.find(({ url }) => url.endsWith('rules.write'));
  if (write === undefined) throw new Error('nothing was written');
  return (write.body as { content: string }).content;
};

describe('Project widget', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('registers as the project widget', () => {
    expect(WIDGETS.get('project')).toBe(PROJECT_WIDGET);
    expect(PROJECT_WIDGET.title).toBe('Project');
  });

  it('says so when there is no project', () => {
    const { container, unmount } = mount(emptyTables());
    expect(textOf(container, '.qd-empty')).toBe('No projects yet.');
    unmount();
  });

  it('shows the open round and ends or kills it', async () => {
    const { container, sent, unmount } = mount(projectTables());
    const roundSection = section(container, 'Round');
    expect(textOf(roundSection, '.qd-project-round-label')).toBe(
      'Round 2 · active',
    );
    expect(textOf(roundSection, '.qd-project-goal')).toBe(
      'Ship the project widget',
    );
    expect(names(roundSection)).toEqual(['End round', 'Kill round']);
    click(button(roundSection, 'End round'));
    await settle();
    click(button(roundSection, 'Kill round'));
    await settle();
    expect(sentTo(sent)).toEqual([
      ['round.end', { project: 'deck', roundId: ROUND_ID }],
      ['round.kill', { project: 'deck', roundId: ROUND_ID }],
    ]);
    unmount();
  });

  it('starts a round with a goal once there is one', async () => {
    const { container, sent, unmount } = mount(projectTables());
    pickProject(container, SITE_ID);
    const roundSection = () => section(container, 'Round');
    expect(textOf(roundSection(), '.qd-empty')).toBe('No round running.');
    expect(isDisabled(button(roundSection(), 'Start round'))).toBe(true);
    type(roundSection(), '   ');
    expect(isDisabled(button(roundSection(), 'Start round'))).toBe(true);
    type(roundSection(), 'Launch the site');
    click(button(roundSection(), 'Start round'));
    await settle();
    expect(sentTo(sent)).toEqual([
      ['round.start', { project: 'site', goal: 'Launch the site' }],
    ]);
    expect((find(roundSection(), 'input') as unknown as HappyInput).value).toBe(
      '',
    );
    unmount();
  });

  it('follows the stream when a round starts', () => {
    const { container, unmount } = mount(projectTables());
    pickProject(container, SITE_ID);
    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'change',
        table: 'rounds',
        op: 'insert',
        id: '00000000-0000-4000-8000-0000000000b9',
        row: round('00000000-0000-4000-8000-0000000000b9', 1, {
          projectId: SITE_ID,
          status: 'planning',
          goal: 'Launch',
        }),
      });
    });
    expect(names(section(container, 'Round'))).toEqual([
      'End round',
      'Kill round',
    ]);
    unmount();
  });

  it('pauses and resumes', async () => {
    const { container, sent, unmount } = mount(projectTables());
    const toggles = section(container, 'Toggles');
    click(button(toggles, 'Pause'));
    await settle();
    click(button(toggles, 'Resume'));
    await settle();
    expect(sentTo(sent)).toEqual([
      ['pause.set', { project: 'deck', paused: true }],
      ['pause.set', { project: 'deck', paused: false }],
    ]);
    unmount();
  });

  it('shows Copilot and Auto-merge from the loaded lifecycle rule, labelled machine-wide', async () => {
    const { container, asked, unmount } = mount(projectTables());
    await settle();
    expect(asked).toEqual(['deck']);
    expect(gates(container)).toEqual([
      ['Copilot', false, false],
      ['Auto-merge', false, false],
    ]);
    const machinePath = `${HOME}/rules.local.lifecycle.json`;
    expect(gate(container, 'requireCopilotReview').getAttribute('title')).toBe(
      `Machine-wide: sets mergeGate.requireCopilotReview in ${machinePath}, which applies to every project.`,
    );
    expect(gate(container, 'autoMerge').getAttribute('title')).toBe(
      `Machine-wide: sets mergeGate.autoMerge in ${machinePath}, which applies to every project.`,
    );
    unmount();
  });

  it('turns Copilot on in the machine layer and keeps its other keys', async () => {
    const machine = JSON.stringify({
      stuckAfterMinutes: 45,
      mergeGate: { requireChecksPassing: false },
    });
    const { container, sent, unmount } = mount(
      projectTables(),
      200,
      {},
      {
        machine,
      },
    );
    await settle();
    click(find(gate(container, 'requireCopilotReview'), 'input'));
    await settle();
    expect(sentTo(sent)).toEqual([
      [
        'rules.write',
        { scope: 'machine', name: 'lifecycle', content: expect.any(String) },
      ],
    ]);
    expect(JSON.parse(writtenContent(sent))).toEqual({
      stuckAfterMinutes: 45,
      mergeGate: { requireChecksPassing: false, requireCopilotReview: true },
    });
    expect(gates(container)).toEqual([
      ['Copilot', true, false],
      ['Auto-merge', false, false],
    ]);
    unmount();
  });

  it('turns Auto-merge off again in the machine layer', async () => {
    const machine = JSON.stringify({
      autoEndSettleSeconds: 300,
      mergeGate: { autoMerge: true },
    });
    const { container, sent, unmount } = mount(
      projectTables(),
      200,
      {},
      {
        machine,
      },
    );
    await settle();
    expect(gates(container)).toEqual([
      ['Copilot', false, false],
      ['Auto-merge', true, false],
    ]);
    click(find(gate(container, 'autoMerge'), 'input'));
    await settle();
    expect(JSON.parse(writtenContent(sent))).toEqual({
      autoEndSettleSeconds: 300,
      mergeGate: { autoMerge: false },
    });
    expect(gates(container)).toEqual([
      ['Copilot', false, false],
      ['Auto-merge', false, false],
    ]);
    unmount();
  });

  it('locks a toggle the repo layer pins and says why', async () => {
    const { container, sent, unmount } = mount(
      projectTables(),
      200,
      {},
      {
        machine: JSON.stringify({ mergeGate: { autoMerge: true } }),
        repo: JSON.stringify({
          mergeGate: { requireCopilotReview: true, autoMerge: false },
        }),
      },
    );
    await settle();
    expect(gates(container)).toEqual([
      ['Copilot', true, true],
      ['Auto-merge', false, true],
    ]);
    expect(gate(container, 'autoMerge').getAttribute('title')).toContain(
      `This project's repo layer (${REPO}/.quarterdeck/rules.local.lifecycle.json) pins it`,
    );
    click(find(gate(container, 'autoMerge'), 'input'));
    await settle();
    expect(sent).toEqual([]);
    unmount();
  });

  it('refuses to toggle over a machine layer it cannot read', async () => {
    const { container, sent, unmount } = mount(
      projectTables(),
      200,
      {},
      {
        machine: '{',
      },
    );
    await settle();
    const toggles = section(container, 'Toggles');
    expect(all(toggles, '[data-gate]')).toHaveLength(0);
    expect(textOf(toggles, '[role="alert"]')).toContain(
      `${HOME}/rules.local.lifecycle.json`,
    );
    expect(sent).toEqual([]);
    unmount();
  });

  it('shows the reviewer and retired count and retires every idle builder and reviewer', async () => {
    const { container, sent, unmount } = mount(projectTables());
    const agents = section(container, 'Agents');
    expect(textOf(agents, '[data-field="reviewer"]')).toBe('tern');
    expect(textOf(agents, '[data-field="retired"]')).toBe('1');
    click(button(agents, 'Refresh agents (2)'));
    await settle();
    expect(sentTo(sent)).toEqual([
      ['agent.retire', { project: 'deck', agentId: IDLE_BUILDER_ID }],
      ['agent.retire', { project: 'deck', agentId: IDLE_REVIEWER_ID }],
    ]);
    unmount();
  });

  it('has nothing to refresh without idle agents', () => {
    const { container, unmount } = mount(projectTables());
    pickProject(container, SITE_ID);
    const agents = section(container, 'Agents');
    expect(textOf(agents, '[data-field="reviewer"]')).toBe('none');
    expect(isDisabled(button(agents, 'Refresh agents (0)'))).toBe(true);
    unmount();
  });

  it('archives a project and unarchives an archived one', async () => {
    const { container, sent, unmount } = mount(projectTables(), 200);
    click(button(section(container, 'Archive'), 'Archive'));
    await settle();
    pickProject(container, OLD_ID);
    click(button(section(container, 'Archive'), 'Unarchive'));
    await settle();
    expect(sentTo(sent)).toEqual([
      ['project.archive', { project: 'deck', archived: true }],
      ['project.archive', { project: 'old', archived: false }],
    ]);
    unmount();
  });

  it('shows a refusal from the server where it happened', async () => {
    const { container, unmount } = mount(projectTables(), 409, {
      error: `round ${ROUND_ID} has already ended`,
    });
    click(button(section(container, 'Round'), 'End round'));
    await settle();
    expect(textOf(section(container, 'Round'), '[role="alert"]')).toBe(
      `round ${ROUND_ID} has already ended`,
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(isDisabled(button(section(container, 'Round'), 'End round'))).toBe(
      false,
    );
    unmount();
  });

  it('keeps one project per copy on the grid', () => {
    const { container, unmount } = render(
      <DeckProvider stream={stream} rules={fakeRules({}).read}>
        <section data-copy="1">
          <ProjectWidget />
        </section>
        <section data-copy="2">
          <ProjectWidget />
        </section>
      </DeckProvider>,
    );
    act(() => {
      FakeSocket.opened[0]?.deliver({
        type: 'snapshot',
        cursor: 0,
        tables: projectTables(),
      });
    });
    const copy = (n: number) => find(container, `[data-copy="${n}"]`);
    pickProject(copy(1), SITE_ID);
    expect(
      all(container, '.qd-project-picker select').map(
        (select) => (select as unknown as HappyInput).value,
      ),
    ).toEqual([SITE_ID, DECK_ID]);
    unmount();
  });
});
