// @vitest-environment happy-dom
import type {
  SetupDetectResult,
  SetupSignIn,
  SetupTool,
} from '@quarterdeck/server/intents';
import type {
  StreamMessage,
  VoyageRow,
} from '@quarterdeck/server/stream-schema';
import type { HTMLInputElement as HappyInput, Window } from 'happy-dom';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RulesView } from '@quarterdeck/server/intents';
import {
  createIntentClient,
  createRulesReader,
  emptyTables,
} from '../../src/api/index.js';
import { App } from '../../src/App.js';
import { GO_LABEL } from '../../src/setup/GoStep.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import {
  PROJECT_ID,
  projectRow,
  snapshotWith,
} from '../layouts/stream-rows.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';
import {
  buttonNamed,
  check,
  clickButton,
  find,
  isChecked,
  isDisabled,
} from '../widgets/cards/dom.js';

const ROOT = '/Users/me/code';
const DECK = `${ROOT}/deck`;
const AT = '2026-10-10T12:00:00.000Z';

const win = (): Window => (globalThis as unknown as { window: Window }).window;

const claude = { kind: 'runtime', runtime: 'claude' } as const;

interface FakeServer {
  needsSetup: boolean;
  claudeSignedIn: boolean;
  signIn: SetupSignIn | null;
  detection: SetupDetectResult;
  sent: Array<{ name: string; body: Record<string, unknown> }>;
}

const runtimeTool = (
  runtime: 'kiro' | 'claude' | 'gemini',
  name: string,
  installed: boolean,
  signedIn: boolean,
): SetupTool => ({
  tool: { kind: 'runtime', runtime },
  name,
  state: 'checked',
  installed,
  signedIn,
  hint: (!installed && `install ${runtime}`) || null,
});

const toolsOf = (server: FakeServer, root: unknown) => ({
  runtimes: [
    runtimeTool('kiro', 'Kiro', false, false),
    runtimeTool('claude', 'Claude Code', true, server.claudeSignedIn),
    runtimeTool('gemini', 'Gemini CLI', false, false),
  ],
  forges:
    (root !== undefined && [
      {
        tool: { kind: 'gh' },
        name: 'GitHub (gh)',
        state: 'signed in',
        installed: true,
        signedIn: true,
        hint: null,
      },
    ]) ||
    [],
  defaultRuntime: 'claude',
});

const reply = (name: string, result: unknown, status = 200): Response =>
  new Response(
    JSON.stringify({ intent: name, status: 'applied', id: null, result }),
    { status },
  );

const MACHINE = '/Users/me/.quarterdeck';
const PROFILE_LAYER = `${MACHINE}/rules.local.profile.json`;

const ruleView = (name: 'profile' | 'models', file: string) => ({
  name,
  file,
  defaults: { path: `/clone/rules/${file}`, content: '{}' },
  machine: { path: `${MACHINE}/rules.local.${file}`, content: null },
  repo: null,
});

const profileOf = (name: string, source: 'shipped' | 'machine') => ({
  name,
  source,
  dir: `/profiles/${name}`,
  description: `The ${name} standard.`,
  files: [`/profiles/${name}/standards.md`],
  levels: {},
  setup: false,
  error: null,
});

const RULES_VIEW: RulesView = {
  project: null,
  repoPath: null,
  rules: [
    ruleView('profile', 'profile.json'),
    ruleView('models', 'models.json'),
  ],
  profiles: {
    active: 'default',
    chosenBy: 'shipped',
    levels: {},
    profiles: [profileOf('default', 'shipped'), profileOf('house', 'machine')],
    steeringFiles: [
      {
        file: 'charter.md',
        controls: 'How the Driver runs a voyage.',
        machine: `${MACHINE}/rules.local.charter.md`,
        repo: null,
      },
    ],
    error: null,
  },
};

const answer = (
  server: FakeServer,
  name: string,
  body: Record<string, unknown>,
) => {
  if (name === 'rules') return new Response(JSON.stringify(RULES_VIEW));
  if (name === 'setup.read') {
    return reply(name, {
      needsSetup: server.needsSetup,
      signIns: (server.signIn && [server.signIn]) || [],
    });
  }
  if (name === 'setup.tools') return reply(name, toolsOf(server, body['root']));
  if (name === 'setup.detect') return reply(name, server.detection);
  if (name === 'setup.sign_in') {
    server.signIn = {
      key: 'runtime:claude',
      tool: claude,
      name: 'Claude Code',
      progress: { status: 'waiting', code: 'WXYZ-9876' },
    };
    return reply(name, { signIn: server.signIn });
  }
  if (name === 'setup.save') {
    server.needsSetup = false;
    return reply(name, {
      mode: 'single',
      projects: ['deck'],
      runtime: 'claude',
      notice: null,
    });
  }
  return new Response(JSON.stringify({ error: `no ${name} here` }), {
    status: 404,
  });
};

const fakeServer = (detection: SetupDetectResult): FakeServer => ({
  needsSetup: true,
  claudeSignedIn: false,
  signIn: null,
  detection,
  sent: [],
});

const sourcesFor = (server: FakeServer) => {
  const fetch = async (input: unknown, init?: RequestInit) => {
    const name = String(input).split('/').at(-1) ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    server.sent.push({ name, body });
    return answer(server, name, body);
  };
  return {
    intents: createIntentClient({ fetch }),
    rules: createRulesReader({ fetch }),
    stream: { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET },
  };
};

const pick = (select: PageElement, value: string): void => {
  const field = select as unknown as HappyInput;
  act(() => {
    field.value = value;
    field.dispatchEvent(new (win().Event)('change', { bubbles: true }));
  });
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const typePath = async (scope: PageElement, text: string): Promise<void> => {
  const field = find(scope, '.qd-setup-path') as unknown as HappyInput;
  const setValue = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field),
    'value',
  )?.set;
  act(() => {
    setValue?.call(field, text);
    field.dispatchEvent(new (win().Event)('input', { bubbles: true }));
  });
  expect(isDisabled(buttonNamed(scope, 'Look'))).toBe(false);
  const form = find(scope, '.qd-setup-step form') as unknown as HappyInput;
  await act(async () => {
    form.dispatchEvent(
      new (win().Event)('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
  await settle();
};

const voyage: VoyageRow = {
  id: '00000000-0000-4000-8000-0000000000aa',
  projectId: PROJECT_ID,
  number: 1,
  status: 'active',
  goal: 'First.',
  projects: ['deck'],
  startedAt: AT,
  endedAt: null,
};

const single: SetupDetectResult = {
  root: DECK,
  mode: 'single',
  repositories: [
    {
      slug: 'deck',
      name: 'deck',
      repoPath: DECK,
      repository: 'github.com/me/deck',
    },
  ],
};

const several: SetupDetectResult = {
  root: ROOT,
  mode: 'multi',
  repositories: [
    { slug: 'deck', name: 'deck', repoPath: DECK, repository: null },
    { slug: 'site', name: 'site', repoPath: `${ROOT}/site`, repository: null },
  ],
};

const deliver = (message: StreamMessage): void => {
  const socket = FakeSocket.opened.at(-1);
  if (socket === undefined) throw new Error('no socket opened');
  act(() => {
    socket.deliver(message);
  });
};

describe('the Setup screen', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('opens instead of the board when there is no workspace, and walks the steps to the board', async () => {
    const server = fakeServer(single);
    const { container, unmount } = render(<App {...sourcesFor(server)} />);
    await settle();

    expect(container.querySelector('.qd-setup')).not.toBeNull();
    expect(container.querySelector('[data-widget-mount]')).toBeNull();
    expect(textOf(container, '.qd-setup-progress-line')).toBe(
      'Step 1 of 5: Workspace',
    );
    const runtimes = all(container, 'input[name="runtime"]');
    expect(runtimes).toHaveLength(1);
    expect(isChecked(runtimes[0] as PageElement)).toBe(true);
    expect(textOf(container, '.qd-setup-missing')).toContain(
      'Kiro is not installed.',
    );
    expect(textOf(container, '.qd-setup-missing')).toContain('install kiro');
    expect(isDisabled(buttonNamed(container, GO_LABEL))).toBe(true);

    await typePath(container, DECK);
    expect(textOf(container, '.qd-setup-summary')).toBe(
      'One repository: deck. Quarterdeck works on it alone.',
    );
    expect(
      server.sent.filter(({ name }) => name === 'setup.tools').at(-1),
    ).toEqual({
      name: 'setup.tools',
      body: { root: DECK },
    });
    expect(textOf(container, '.qd-setup-progress-line')).toBe(
      'Step 4 of 5: Sign in',
    );
    expect(textOf(container, '.qd-setup-step[aria-label="Sign in"]')).toContain(
      'GitHub (gh)',
    );

    await clickButton(container, 'Sign in to Claude Code');
    await settle();
    expect(server.sent.at(-1)).toEqual({
      name: 'setup.sign_in',
      body: { tool: claude },
    });
    expect(textOf(container, '.qd-card-signin-code')).toBe('Code: WXYZ-9876');

    server.claudeSignedIn = true;
    server.signIn = {
      ...(server.signIn as SetupSignIn),
      progress: { status: 'signed_in' },
    };
    await vi.waitFor(
      async () => {
        await settle();
        expect(textOf(container, '.qd-setup-progress-line')).toBe(
          'Step 5 of 5: Go',
        );
      },
      { timeout: 4000 },
    );

    await clickButton(container, GO_LABEL);
    await settle();
    expect(server.sent.find(({ name }) => name === 'setup.save')?.body).toEqual(
      {
        root: DECK,
        runtime: 'claude',
        skip: [],
      },
    );
    expect(container.querySelector('.qd-setup')).toBeNull();
    expect(container.querySelector('[data-widget-mount]')).not.toBeNull();

    deliver(snapshotWith());
    expect(textOf(container, '.qd-first-voyage-title')).toBe(
      'What to do first',
    );
    expect(textOf(container, '.qd-first-voyage')).toContain('Start Voyage');
    deliver({
      type: 'snapshot',
      cursor: 0,
      tables: { ...emptyTables(), projects: [projectRow()], voyages: [voyage] },
      machine: { pausedAt: null },
      layout: null,
    });
    expect(container.querySelector('.qd-first-voyage')).toBeNull();
    unmount();
  });

  it('lists a folder of repositories and leaves out the ones unticked', async () => {
    const server = fakeServer(several);
    server.claudeSignedIn = true;
    const { container, unmount } = render(<App {...sourcesFor(server)} />);
    await settle();
    await typePath(container, '~/code');
    expect(textOf(container, '.qd-setup-summary')).toContain(
      `2 repositories in ${ROOT}, each one a project.`,
    );
    const boxes = all(
      container,
      '.qd-setup-step[aria-label="Workspace"] input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    check(boxes[1] as PageElement);
    await clickButton(container, GO_LABEL);
    await settle();
    expect(server.sent.find(({ name }) => name === 'setup.save')?.body).toEqual(
      {
        root: ROOT,
        runtime: 'claude',
        skip: ['site'],
      },
    );
    unmount();
  });

  it('offers the installed profiles, names the file a new pick writes and the files a person may edit, and saves the pick', async () => {
    const server = fakeServer(single);
    server.claudeSignedIn = true;
    const { container, unmount } = render(<App {...sourcesFor(server)} />);
    await settle();
    const step = '.qd-setup-step[aria-label="Profile"]';
    expect(textOf(container, step)).toContain('3. Profile');
    expect(
      all(container, `${step} option`).map(({ textContent }) => textContent),
    ).toEqual(['default (shipped)', 'house (this machine)']);
    expect(textOf(container, step)).toContain(
      'Keeps default, the profile this machine has now.',
    );
    expect(textOf(container, `${step} [aria-label="Files you may edit"]`)).toBe(
      `${MACHINE}/rules.local.charter.md How the Driver runs a voyage.`,
    );
    expect(textOf(container, '[aria-label="Files Go writes"]')).not.toContain(
      PROFILE_LAYER,
    );

    pick(find(container, `${step} select`), 'house');
    expect(textOf(container, step)).toContain(
      `Go writes "profile": "house" to ${PROFILE_LAYER}.`,
    );
    expect(textOf(container, step)).toContain('/profiles/house/standards.md');
    expect(textOf(container, '[aria-label="Files Go writes"]')).toContain(
      `${PROFILE_LAYER}, for the house profile`,
    );

    await typePath(container, DECK);
    await clickButton(container, GO_LABEL);
    await settle();
    expect(server.sent.find(({ name }) => name === 'setup.save')?.body).toEqual(
      { root: DECK, runtime: 'claude', profile: 'house', skip: [] },
    );
    unmount();
  });

  it('stays on the board when the server already has a workspace', async () => {
    const server = fakeServer(single);
    server.needsSetup = false;
    const { container, unmount } = render(<App {...sourcesFor(server)} />);
    await settle();
    expect(container.querySelector('.qd-setup')).toBeNull();
    expect(container.querySelector('[data-widget-mount]')).not.toBeNull();
    unmount();
  });
});
