// @vitest-environment happy-dom
import type { ProjectRequests } from '@quarterdeck/server/intents';
import { LAYOUT_PRESETS } from '@quarterdeck/server/layouts';
import type { StreamMessage } from '@quarterdeck/server/stream-schema';
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
import { NOW_TICK_MS } from '../../../src/lib/use-now.js';
import REQUESTS_WIDGET, {
  RequestsWidget,
} from '../../../src/widgets/requests/RequestsWidget.js';
import { WIDGETS } from '../../../src/widgets/widgets.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../../api/fake-socket.js';
import { all, render, textOf, type PageElement } from '../../shell/page.js';
import {
  NOW,
  TICKET,
  githubRequest,
  gitlabRequest,
  linked,
  projectRequests,
  streamProject,
  ticketEvent,
} from './fixtures.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

type Answer = ProjectRequests[] | { status: number; error: string };

interface Harness {
  container: PageElement;
  sent: { url: string; body: unknown }[];
  answer: (next: Answer) => void;
  deliver: (message: StreamMessage) => void;
  unmount: () => void;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const replyTo = (answer: Answer): Response => {
  if ('error' in answer) {
    return new Response(JSON.stringify({ error: answer.error }), {
      status: answer.status,
    });
  }
  return new Response(
    JSON.stringify({
      intent: 'forge.requests',
      status: 'applied',
      id: null,
      result: { projects: answer },
    }),
    { status: 200 },
  );
};

const snapshot: StreamMessage = {
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects: [streamProject] },
  machine: { pausedAt: null },
};

const mount = async (first: Answer): Promise<Harness> => {
  let current = first;
  const sent: Harness['sent'] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(replyTo(current));
  });
  const intents = createIntentClient({ fetch });
  const { container, unmount } = render(
    <DeckProvider stream={stream} intents={intents}>
      <RequestsWidget />
    </DeckProvider>,
  );
  const deliver = (message: StreamMessage) => {
    act(() => {
      FakeSocket.opened[0]?.deliver(message);
    });
  };
  deliver(snapshot);
  await flush();
  return {
    container,
    sent,
    answer: (next) => {
      current = next;
    },
    deliver,
    unmount,
  };
};

const section = (container: PageElement, project: string): PageElement => {
  const found = container.querySelector(`section[aria-label="${project}"]`);
  if (found === null) throw new Error(`no section for ${project}`);
  return found;
};

const headings = (scope: PageElement) =>
  all(scope, 'th').map((th) => th.textContent);

const links = (scope: PageElement) =>
  all(scope, 'a').map((a) => ({
    text: a.textContent,
    href: a.getAttribute('href'),
    label: a.getAttribute('aria-label'),
  }));

const cells = (scope: PageElement) =>
  all(scope, 'tbody tr').map((row) =>
    all(row, 'td').map((cell) => cell.textContent),
  );

describe('Requests widget', () => {
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

  it('registers with a neutral title and sits in the default and ops presets', () => {
    expect(WIDGETS.get('requests')).toBe(REQUESTS_WIDGET);
    expect(REQUESTS_WIDGET.title).toBe('Pull and merge requests');
    const widgets = (name: 'default' | 'ops') =>
      LAYOUT_PRESETS[name].items.map(({ widget }) => widget);
    expect(widgets('default')).toContain('requests');
    expect(widgets('ops')).toContain('requests');
  });

  it('says it is reading before the first answer', () => {
    const pending = createIntentClient({
      fetch: () => new Promise<Response>(() => undefined),
    });
    const { container, unmount } = render(
      <DeckProvider stream={stream} intents={pending}>
        <RequestsWidget />
      </DeckProvider>,
    );
    expect(textOf(container, '.qd-empty')).toBe('Reading open requests…');
    unmount();
  });

  it('lists a GitHub project’s pull requests in pull request terms, with the linked ticket and agent', async () => {
    const { container, sent, unmount } = await mount([
      projectRequests('example', 'github', [
        githubRequest(7, { ...linked, review: 'approved' }),
        githubRequest(8, {
          draft: true,
          author: null,
          checks: 'failing',
          review: 'changes',
          createdAt: new Date(NOW - 3 * 86_400_000).toISOString(),
        }),
      ]),
    ]);

    expect(sent).toEqual([{ url: '/api/intents/forge.requests', body: {} }]);
    expect(textOf(container, '.qd-requests-title')).toBe('Pull requests');
    const example = section(container, 'example');
    expect(textOf(example, 'h4')).toBe('exampleGitHub');
    expect(headings(example)).toEqual([
      'PR',
      'Title',
      'Author',
      'Branch',
      'Checks',
      'Review',
      'Ticket',
      'Age',
    ]);
    expect(links(example)).toEqual([
      {
        text: '#7',
        href: 'https://github.com/example-org/example/pull/7',
        label: 'Open PR #7 on GitHub',
      },
      {
        text: '#8',
        href: 'https://github.com/example-org/example/pull/8',
        label: 'Open PR #8 on GitHub',
      },
    ]);
    expect(cells(example)).toEqual([
      [
        '#7',
        'Change 7',
        'okapi',
        'topic-7 → main',
        'Passing',
        'Approved',
        'Add the berth mapgannet',
        '2h ago',
      ],
      [
        '#8',
        'Change 8Draft',
        'unknown',
        'topic-8 → main',
        'Failing',
        'Changes requested',
        '—',
        '3d ago',
      ],
    ]);
    expect(
      example
        .querySelector('.qd-requests-ticket')
        ?.getAttribute('data-ticket-id'),
    ).toBe(TICKET);
    unmount();
  });

  it('lists a GitLab project’s merge requests in merge request terms', async () => {
    const { container, unmount } = await mount([
      projectRequests('sample', 'gitlab', [
        gitlabRequest(3, { ...linked, checks: 'pending' }),
      ]),
    ]);

    expect(textOf(container, '.qd-requests-title')).toBe('Merge requests');
    const sample = section(container, 'sample');
    expect(headings(sample)).toEqual([
      'MR',
      'Title',
      'Author',
      'Branch',
      'Pipeline',
      'Review',
      'Ticket',
      'Age',
    ]);
    expect(links(sample)).toEqual([
      {
        text: '!3',
        href: 'https://gitlab.com/example-org/sample/-/merge_requests/3',
        label: 'Open MR !3 on GitLab',
      },
    ]);
    expect(cells(sample)[0]?.slice(4, 7)).toEqual([
      'Running',
      'No review',
      'Add the berth mapgannet',
    ]);
    expect(container.textContent).not.toContain('Pull request');
    expect(container.textContent).not.toContain('PR');
    unmount();
  });

  it('titles a mixed set neutrally and gives each project its own terms', async () => {
    const { container, unmount } = await mount([
      projectRequests('example', 'github', [githubRequest(7, linked)]),
      projectRequests('sample', 'gitlab', [gitlabRequest(3)]),
    ]);

    expect(textOf(container, '.qd-requests-title')).toBe(
      'Pull and merge requests',
    );
    const example = section(container, 'example');
    const sample = section(container, 'sample');
    expect(headings(example)[0]).toBe('PR');
    expect(headings(example)[4]).toBe('Checks');
    expect(links(example)[0]?.label).toBe('Open PR #7 on GitHub');
    expect(textOf(example, '.qd-requests-ticket')).toBe('Add the berth map');
    expect(headings(sample)[0]).toBe('MR');
    expect(headings(sample)[4]).toBe('Pipeline');
    expect(links(sample)[0]?.label).toBe('Open MR !3 on GitLab');
    expect(textOf(sample, 'tbody td:nth-child(7)')).toBe('—');
    unmount();
  });

  it('shows one project’s forge error inline while the others render', async () => {
    const { container, unmount } = await mount([
      projectRequests('example', 'github', [], 'gh pr list failed: HTTP 502'),
      projectRequests('sample', 'gitlab', [gitlabRequest(3), gitlabRequest(4)]),
    ]);

    const example = section(container, 'example');
    expect(textOf(example, '[role="alert"]')).toBe(
      'gh pr list failed: HTTP 502',
    );
    expect(example.querySelector('table')).toBeNull();
    const sample = section(container, 'sample');
    expect(sample.querySelector('[role="alert"]')).toBeNull();
    expect(cells(sample)).toHaveLength(2);
    expect(container.querySelector('.qd-requests-error')).toBeNull();
    unmount();
  });

  it('says there is nothing open in the forge’s terms, or neutrally when mixed', async () => {
    const github = await mount([projectRequests('example', 'github', [])]);
    expect(textOf(github.container, '.qd-empty')).toBe('No open pull requests');
    github.unmount();
    FakeSocket.opened = [];

    const gitlab = await mount([projectRequests('sample', 'gitlab', [])]);
    expect(textOf(gitlab.container, '.qd-empty')).toBe(
      'No open merge requests',
    );
    gitlab.unmount();
    FakeSocket.opened = [];

    const mixed = await mount([
      projectRequests('example', 'github', []),
      projectRequests('sample', 'gitlab', []),
    ]);
    expect(textOf(mixed.container, '.qd-empty')).toBe(
      'No open pull or merge requests',
    );
    mixed.unmount();
    FakeSocket.opened = [];

    const none = await mount([]);
    expect(textOf(none.container, '.qd-empty')).toBe(
      'No active project has a repository',
    );
    none.unmount();
  });

  it('links only http and https URLs, showing any other as plain text', async () => {
    const { container, unmount } = await mount([
      projectRequests('example', 'github', [
        githubRequest(7, { url: 'javascript:alert(1)' }),
        githubRequest(8),
      ]),
    ]);

    expect(links(container).map(({ text }) => text)).toEqual(['#8']);
    expect(cells(container)[0]?.[0]).toBe('#7');
    unmount();
  });

  it('gives a quiet project its own empty line beside a busy one', async () => {
    const { container, unmount } = await mount([
      projectRequests('example', 'github', []),
      projectRequests('sample', 'gitlab', [gitlabRequest(3)]),
    ]);

    expect(textOf(section(container, 'example'), '.qd-empty')).toBe(
      'No open pull requests',
    );
    expect(section(container, 'sample').querySelector('.qd-empty')).toBeNull();
    unmount();
  });

  it('reads again on a ticket event and as the clock moves', async () => {
    const { container, sent, answer, deliver, unmount } = await mount([
      projectRequests('example', 'github', [githubRequest(7)]),
    ]);
    answer([projectRequests('example', 'github', [])]);

    deliver({ type: 'event', event: ticketEvent(1, 'agent.spawned') });
    await flush();
    expect(sent).toHaveLength(1);

    deliver({ type: 'event', event: ticketEvent(2, 'ticket.merged') });
    await flush();
    expect(sent).toHaveLength(2);
    expect(textOf(container, '.qd-empty')).toBe('No open pull requests');

    answer([projectRequests('example', 'github', [githubRequest(9)])]);
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    await flush();
    expect(sent).toHaveLength(3);
    expect(links(container)[0]?.text).toBe('#9');
    unmount();
  });

  it('says why a read failed and keeps the last list', async () => {
    const { container, answer, unmount } = await mount([
      projectRequests('example', 'github', [githubRequest(7)]),
    ]);
    answer({ status: 500, error: 'the server is restarting' });
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    await flush();

    expect(textOf(container, '.qd-requests-error')).toBe(
      'the server is restarting',
    );
    expect(links(container)[0]?.text).toBe('#7');
    unmount();
  });
});
