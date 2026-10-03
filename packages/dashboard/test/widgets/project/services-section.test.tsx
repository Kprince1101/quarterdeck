// @vitest-environment happy-dom
import type { ServicesReadResult } from '@quarterdeck/server/intents';
import type { HTMLInputElement as HappyInput, Window } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient } from '../../../src/api/index.js';
import { DeckProvider } from '../../../src/deck/DeckProvider.js';
import { ProjectWidget } from '../../../src/widgets/project/ProjectWidget.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { choose, click } from '../../grid/events.js';
import { rulesView } from '../../rules/fixtures.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import { SITE_ID, projectTables } from './fixtures.js';
import {
  SERVICES_RULES_PATH,
  servicesAnswer,
  servicesRead,
} from './services-fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

const MCP_TRACKER = {
  kind: 'tracker-mcp',
  how: 'mcp',
  server: 'tracker-mcp',
  notes: 'tickets are stories in the Example board',
} as const;

interface Sent {
  name: string;
  body: unknown;
}

const mount = (reads: ServicesReadResult[]) => {
  const sent: Sent[] = [];
  const queue = [...reads];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    const name = String(url).split('/').at(-1) ?? '';
    const body: unknown = JSON.parse(String(init?.body));
    if (name === 'services.read') {
      sent.push({ name, body });
      return Promise.resolve(servicesAnswer(queue.shift() ?? servicesRead()));
    }
    if (name === 'services.set') sent.push({ name, body });
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  const intents = createIntentClient({ baseUrl: 'http://deck.test', fetch });
  const rules = () => Promise.resolve(rulesView({}, null));
  const rendered = render(
    <DeckProvider stream={stream} intents={intents} rules={rules}>
      <ProjectWidget />
    </DeckProvider>,
  );
  act(() => {
    FakeSocket.opened[0]?.deliver({
      type: 'snapshot',
      cursor: 0,
      tables: projectTables(),
      machine: { pausedAt: null },
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

const services = (scope: PageElement) =>
  find(scope, 'section[aria-label="Services"]');

const field = (scope: PageElement, label: string): PageElement => {
  const found = all(scope, '.qd-project-field').find(
    (element) => element.querySelector('span')?.textContent === label,
  );
  if (found === undefined) throw new Error(`no ${label} field`);
  return find(found, 'input, select, textarea');
};

const button = (scope: PageElement, name: string): PageElement => {
  const found = all(scope, 'button').find(
    ({ textContent }) => textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};

const valueOf = (element: PageElement): string =>
  (element as unknown as HappyInput).value;

const type = (element: PageElement, text: string) => {
  const input = element as unknown as HappyInput;
  const win = (globalThis as unknown as { window: Window }).window;
  act(() => {
    const prototype = Object.getPrototypeOf(input) as object;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
};

const isDisabled = (element: PageElement): boolean =>
  element.getAttribute('disabled') !== null;

describe('Project widget services', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('shows the detected forge read-only and where the values come from', async () => {
    const { container, sent, unmount } = mount([servicesRead()]);
    await settle();
    const section = services(container);

    expect(sent).toEqual([
      { name: 'services.read', body: { project: 'deck' } },
    ]);
    expect(textOf(section, '.qd-project-forge-value')).toBe(
      'GitHub at github.com (gh CLI)',
    );
    expect(section.querySelector('.qd-project-forge input')).toBeNull();
    expect(textOf(section, '.qd-project-note')).toBe(
      `Tracker not set, publishes not set. ${SERVICES_RULES_PATH} can set both per project; a value saved here wins.`,
    );
    expect(isDisabled(field(section, 'Command or server'))).toBe(true);
    unmount();
  });

  it('fills the form from the project and saves an MCP tracker and publishes', async () => {
    const saved = servicesRead({
      tracker: MCP_TRACKER,
      trackerFrom: 'project',
      publishes: true,
      publishesFrom: 'project',
    });
    const { container, sent, unmount } = mount([servicesRead(), saved]);
    await settle();
    const section = () => services(container);

    type(field(section(), 'Tracker'), 'tracker-mcp');
    choose(field(section(), 'Reached by'), 'mcp');
    type(field(section(), 'MCP server name'), 'tracker-mcp');
    type(field(section(), 'Notes'), MCP_TRACKER.notes);
    click(find(section(), '.qd-project-toggle input'));
    click(button(section(), 'Save services'));
    await settle();

    expect(sent.slice(1)).toEqual([
      {
        name: 'services.set',
        body: { project: 'deck', tracker: MCP_TRACKER, publishes: true },
      },
      { name: 'services.read', body: { project: 'deck' } },
    ]);
    expect(textOf(section(), '.qd-project-note')).toContain(
      'Tracker set here, publishes set here.',
    );
    expect(valueOf(field(section(), 'MCP server name'))).toBe('tracker-mcp');
    unmount();
  });

  it('will not save a tracker that does not say how it is reached', async () => {
    const { container, sent, unmount } = mount([servicesRead()]);
    await settle();
    const section = () => services(container);

    type(field(section(), 'Tracker'), 'tracker-cli');
    choose(field(section(), 'Reached by'), 'cli');

    expect(isDisabled(button(section(), 'Save services'))).toBe(true);
    expect(textOf(section(), '[role="alert"]')).toContain(
      "how: 'cli' needs a command",
    );
    type(field(section(), 'Command'), 'tracker');
    expect(isDisabled(button(section(), 'Save services'))).toBe(false);
    expect(sent).toHaveLength(1);
    unmount();
  });

  it('hands both values back to the rules', async () => {
    const { container, sent, unmount } = mount([
      servicesRead({ tracker: MCP_TRACKER, trackerFrom: 'project' }),
    ]);
    await settle();

    click(button(services(container), 'Use the rules'));
    await settle();

    expect(sent[1]).toEqual({
      name: 'services.set',
      body: { project: 'deck', tracker: null, publishes: null },
    });
    unmount();
  });

  it('shows why the forge could not be read and reads each project', async () => {
    const { container, sent, unmount } = mount([
      servicesRead({
        forge: null,
        forgeError: 'git.example.org is not a forge Quarterdeck knows',
      }),
    ]);
    await settle();
    expect(textOf(services(container), '.qd-project-forge-value')).toBe(
      'git.example.org is not a forge Quarterdeck knows',
    );

    choose(find(container, '.qd-project-picker select'), SITE_ID);
    await settle();

    expect(sent.at(-1)).toEqual({
      name: 'services.read',
      body: { project: 'site' },
    });
    unmount();
  });
});
