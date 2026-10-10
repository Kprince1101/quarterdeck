// @vitest-environment happy-dom
import type {
  Workspace,
  WorkspaceMode,
} from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyStreamMessage,
  emptyTables,
  initialStreamState,
} from '../../src/api/index.js';
import { App } from '../../src/App.js';
import { createDemoServer } from '../../src/demo/demo-server.js';
import { WIDGETS } from '../../src/widgets/widgets.js';
import { all, render, type PageElement } from '../shell/page.js';

const PROJECT_WORD = /project/i;

const SHOWN_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const RULE_FILE_TEXT = [
  '.qd-rules-editor',
  '.qd-rules-text',
  '.qd-rules-value',
];

interface Removable {
  textContent: string | null;
  cloneNode: (deep: boolean) => Removable;
  querySelectorAll: (selector: string) => ArrayLike<{ remove: () => void }>;
}

const withoutRuleFiles = (container: PageElement): string => {
  const copy = (container as unknown as Removable).cloneNode(true);
  RULE_FILE_TEXT.forEach((selector) => {
    Array.from(copy.querySelectorAll(selector)).forEach((file) => {
      file.remove();
    });
  });
  return copy.textContent ?? '';
};

const shownText = (container: PageElement): string[] => [
  withoutRuleFiles(container),
  ...all(container, '*').flatMap((element) =>
    SHOWN_ATTRIBUTES.map((name) => element.getAttribute(name) ?? ''),
  ),
];

const mentions = (container: PageElement): string[] =>
  shownText(container).filter((text) => PROJECT_WORD.test(text));

const alone = (widget: string) => ({
  columns: 12,
  rows: 12,
  items: [
    { id: `${widget}-1`, widget, x: 0, y: 0, w: 12, h: 12, hidden: false },
  ],
});

const renderWidget = async (widget: string, mode: WorkspaceMode) => {
  const server = createDemoServer({ workspace: mode });
  server.store.setLayout(alone(widget));
  server.step();
  const rendered = render(<App {...server.sources} />);
  await flush();
  await flush();
  return {
    ...rendered,
    close: () => {
      rendered.unmount();
      server.stop();
    },
  };
};

const WIDGET_TYPES = [...WIDGETS.keys()];

describe('a single-repository workspace on the dashboard', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(WIDGET_TYPES)(
    'never says project in the %s widget',
    async (widget) => {
      const { container, close } = await renderWidget(widget, 'single');
      expect(container.textContent).not.toBe('');
      expect(mentions(container)).toEqual([]);
      close();
    },
  );

  it('titles the Project widget Repository and hides its selector', async () => {
    const { container, close } = await renderWidget('project', 'single');
    expect(container.querySelector('[aria-label="Repository"]')).not.toBeNull();
    expect(container.querySelector('.qd-project-picker')).toBeNull();
    expect(container.textContent).not.toContain('Publishes');
    close();
  });

  it('hides the Board picker, the project strip names and per-project kills', async () => {
    const { container, close } = await renderWidget('board', 'single');
    expect(container.querySelector('.qd-board-picker')).toBeNull();
    expect(all(container, '.qd-board-project h3')).toHaveLength(0);
    expect(container.querySelector('.qd-board-voyage-projects')).toBeNull();
    close();
  });
});

describe('the workspace on the stream', () => {
  const workspace = (mode: WorkspaceMode, count: number): Workspace => ({
    root: '/home/demo',
    mode,
    projects: Array.from({ length: count }, (_, index) => ({
      slug: `repo-${index}`,
      name: `repo-${index}`,
      repoPath: `/home/demo/repo-${index}`,
      repository: null,
    })),
    updatedAt: '2026-10-10T12:00:00.000Z',
  });

  const live = applyStreamMessage(initialStreamState, {
    type: 'snapshot',
    cursor: 0,
    tables: emptyTables(),
    machine: { pausedAt: null },
    layout: null,
    workspace: workspace('single', 1),
  });

  it('reads the mode from the snapshot', () => {
    expect(live.workspace?.mode).toBe('single');
    expect(live.workspaceNotice).toBeNull();
  });

  it('gives a one-line notice when a second repository switches it to multi', () => {
    const next = applyStreamMessage(live, {
      type: 'workspace',
      workspace: workspace('multi', 2),
    });
    expect(next.workspace?.mode).toBe('multi');
    expect(next.workspaceNotice).toBe(
      'Workspace switched to multi mode: it now has 2 repositories, and each one is a project.',
    );
  });

  it('treats a snapshot without a workspace as multi, as before', () => {
    const before = applyStreamMessage(initialStreamState, {
      type: 'snapshot',
      cursor: 0,
      tables: emptyTables(),
      machine: { pausedAt: null },
      layout: null,
    });
    expect(before.workspace).toBeNull();
  });

  it('shows the workspace in the Data widget', async () => {
    const single = await renderWidget('data', 'single');
    expect(single.container.textContent).toContain(
      'One repository at /home/demo/harbor',
    );
    single.close();
  });
});

describe('a multi-project workspace on the dashboard', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  it('keeps every project surface', async () => {
    const project = await renderWidget('project', 'multi');
    expect(
      project.container.querySelector('[aria-label="Project"]'),
    ).not.toBeNull();
    expect(
      project.container.querySelector('.qd-project-picker'),
    ).not.toBeNull();
    expect(project.container.textContent).toContain('Publishes');
    project.close();

    const board = await renderWidget('board', 'multi');
    expect(board.container.querySelector('.qd-board-picker')).not.toBeNull();
    expect(all(board.container, '.qd-board-project h3')).not.toHaveLength(0);
    board.close();

    const events = await renderWidget('events', 'multi');
    expect(events.container.textContent).toContain('All projects');
    events.close();

    const requests = await renderWidget('requests', 'multi');
    expect(requests.container.textContent).toContain('Lighthouse');
    requests.close();
  });
});
