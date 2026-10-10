import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startApiServer, type ApiServer } from '../../src/api/index.js';
import { dataPaths } from '../../src/data/index.js';
import type { GitRunner } from '../../src/gate/index.js';
import { quarterdeckHome } from '../../src/store/index.js';
import {
  serveStream,
  streamMessageSchema,
  streamProtocols,
  type ServedStream,
  type StreamMessage,
  type Workspace,
  type WorkspaceProject,
} from '../../src/stream/index.js';
import {
  confirmationList,
  createWorkspaces,
  detectWorkspace,
  mergeWorkspace,
  readWorkspace,
  repositoryWording,
  workspacePath,
  workspaceWording,
} from '../../src/workspace/index.js';
import { bearer, readReply } from '../api/harness.js';

const TIMEOUT = 30_000;

const repo = (slug: string, root = '/work'): WorkspaceProject => ({
  slug,
  name: slug,
  repoPath: join(root, slug),
  repository: null,
});

const single = (slug: string): Workspace => ({
  root: join('/work', slug),
  mode: 'single',
  projects: [repo(slug)],
  updatedAt: '2026-10-10T12:00:00.000Z',
});

const origins: GitRunner = async (args) => {
  const path = args[1] ?? '';
  if (path.endsWith('ui-kit')) return 'git@github.com:acme/ui-kit.git\n';
  throw new Error('no origin');
};

describe('detecting a workspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'qd-detect-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('calls a git repository a single workspace', async () => {
    const path = join(root, 'Deck Repo');
    await mkdir(join(path, '.git'), { recursive: true });
    expect(await detectWorkspace(path, { run: origins })).toEqual({
      root: path,
      mode: 'single',
      repositories: [
        {
          slug: 'deck-repo',
          name: 'Deck Repo',
          repoPath: path,
          repository: null,
        },
      ],
    });
  });

  it('makes each git repository one level down a project, skipping hidden folders and plain ones', async () => {
    for (const name of ['ui-kit', 'retrofit-a', '.hidden']) {
      await mkdir(join(root, name, '.git'), { recursive: true });
    }
    await mkdir(join(root, 'notes'));
    await mkdir(join(root, 'nested', 'deep', '.git'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'hi');
    const detection = await detectWorkspace(root, { run: origins });
    expect(detection).toEqual({
      root,
      mode: 'multi',
      repositories: [
        { ...repo('retrofit-a', root) },
        { ...repo('ui-kit', root), repository: 'github.com/acme/ui-kit' },
      ],
    });
    expect(confirmationList(detection)).toEqual([
      `  1. retrofit-a  no origin  ${join(root, 'retrofit-a')}`,
      `  2. ui-kit  github.com/acme/ui-kit  ${join(root, 'ui-kit')}`,
    ]);
  });

  it('refuses a folder with no repository in it, and a missing path', async () => {
    await expect(detectWorkspace(root)).rejects.toMatchObject({
      status: 400,
      message: `${root} is not a git repository (no .git) and holds none one level down`,
    });
    await expect(detectWorkspace(join(root, 'gone'))).rejects.toMatchObject({
      status: 400,
      message: `${join(root, 'gone')} is not a directory`,
    });
  });
});

describe('merging into a workspace', () => {
  it('starts in the mode the path was detected in', () => {
    expect(
      mergeWorkspace(null, {
        root: '/work/deck',
        mode: 'single',
        projects: [repo('deck')],
      }),
    ).toEqual({
      record: { root: '/work/deck', mode: 'single', projects: [repo('deck')] },
      added: [repo('deck')],
      switched: false,
      notice: null,
    });
  });

  it('switches a single workspace to multi with a notice when a second repository arrives', () => {
    const change = mergeWorkspace(single('deck'), {
      root: '/work/other',
      mode: 'single',
      projects: [repo('other')],
    });
    expect(change.record).toEqual({
      root: '/work',
      mode: 'multi',
      projects: [repo('deck'), repo('other')],
    });
    expect(change.switched).toBe(true);
    expect(change.notice).toBe(
      'Workspace switched to multi mode: it now has 2 repositories, and each one is a project.',
    );
  });

  it('takes the folder as the root when a folder of repositories is added', () => {
    const change = mergeWorkspace(single('deck'), {
      root: '/elsewhere',
      mode: 'multi',
      projects: [repo('lib', '/elsewhere')],
    });
    expect(change.record.root).toBe('/elsewhere');
    expect(change.switched).toBe(true);
  });

  it('adds nothing twice and stays single for the same repository', () => {
    const change = mergeWorkspace(single('deck'), {
      root: '/work/deck',
      mode: 'single',
      projects: [repo('deck')],
    });
    expect(change.added).toEqual([]);
    expect(change.record.mode).toBe('single');
    expect(change.notice).toBeNull();
  });

  it('never notices a multi workspace growing', () => {
    const multi = { ...single('deck'), mode: 'multi' as const, root: '/work' };
    const change = mergeWorkspace(multi, {
      root: '/work/other',
      mode: 'single',
      projects: [repo('other')],
    });
    expect(change.notice).toBeNull();
    expect(change.record.root).toBe('/work');
  });
});

describe('the workspace file', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-workspace-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is seeded once from the projects there are: one is single, more are multi', async () => {
    const one = createWorkspaces(join(home, 'one'));
    expect(await one.mode()).toBe('multi');
    expect(
      await one.seed([{ slug: 'deck', name: 'Deck', repoPath: '/work/deck' }]),
    ).toMatchObject({ root: '/work/deck', mode: 'single' });
    expect(await one.mode()).toBe('single');
    expect(
      await one.seed([
        { slug: 'deck', name: 'Deck', repoPath: '/work/deck' },
        { slug: 'other', name: 'Other', repoPath: '/work/other' },
      ]),
    ).toMatchObject({ mode: 'single' });

    const two = createWorkspaces(join(home, 'two'));
    expect(
      await two.seed([
        { slug: 'deck', name: 'Deck', repoPath: '/work/deck' },
        { slug: 'other', name: 'Other', repoPath: '/work/other' },
        { slug: 'bare', name: 'Bare', repoPath: null },
      ]),
    ).toMatchObject({ root: '/work', mode: 'multi' });
    expect(await createWorkspaces(join(home, 'none')).seed([])).toBeNull();
  });

  it('tells subscribers about each change and drops wiped projects', async () => {
    const workspaces = createWorkspaces(home);
    const seen: Workspace[] = [];
    workspaces.subscribe((workspace) => seen.push(workspace));
    await workspaces.add({
      root: '/work/deck',
      mode: 'single',
      projects: [repo('deck')],
    });
    const update = await workspaces.add({
      root: '/work/other',
      mode: 'single',
      projects: [repo('other')],
    });
    expect(update.notice).not.toBeNull();
    expect(seen.map(({ mode }) => mode)).toEqual(['single', 'multi']);
    const after = await workspaces.remove(['deck']);
    expect(after?.projects).toEqual([repo('other')]);
    expect(after?.mode).toBe('multi');
    expect(await readWorkspace(home)).toEqual(after);
  });

  it('ignores a broken file', async () => {
    await writeFile(workspacePath(home), '{ nope');
    expect(await readWorkspace(home)).toBeNull();
    expect(await createWorkspaces(home).mode()).toBe('multi');
  });

  it('is listed in the Data widget paths, on the machine', () => {
    const paths = dataPaths({ homeDir: home, project: 'deck' });
    expect(paths).toContainEqual({
      label: 'Workspace',
      path: workspacePath(quarterdeckHome(home)),
      kind: 'file',
      scope: 'machine',
    });
  });
});

describe('workspace wording', () => {
  const TEXT = [
    'Shared line about the project.',
    'Only with several projects. <!-- multi -->',
    'Only with one repository. <!-- single -->',
    "The project's rules, `project` and project_id and projects(id) stay.",
  ].join('\n');

  it('keeps multi text as it was, without the markers', () => {
    expect(workspaceWording(TEXT, 'multi')).toBe(
      [
        'Shared line about the project.',
        'Only with several projects.',
        "The project's rules, `project` and project_id and projects(id) stay.",
      ].join('\n'),
    );
  });

  it('says repository in single text, leaving identifiers alone', () => {
    expect(workspaceWording(TEXT, 'single')).toBe(
      [
        'Shared line about the repository.',
        'Only with one repository.',
        "The repository's rules, `project` and project_id and projects(id) stay.",
      ].join('\n'),
    );
    expect(repositoryWording('Projects: every project. PROJECT')).toBe(
      'Repositories: every repository. REPOSITORY',
    );
  });
});

describe(
  'the workspace on the API and the stream',
  { timeout: TIMEOUT },
  () => {
    let homeDir: string;
    let api: ApiServer;
    const served: ServedStream[] = [];
    const sockets: WebSocket[] = [];

    const send = async (name: string, body: unknown) =>
      readReply(
        await fetch(`${api.url}/api/intents/${name}`, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...bearer(api.token) },
        }),
      );

    const listen = async (project: string): Promise<StreamMessage[]> => {
      const stream = await serveStream({
        store: await api.stores.get(project),
        home: api.stores.dataHome,
        layouts: api.layouts,
        workspaces: api.workspaces,
        token: api.token,
      });
      served.push(stream);
      const messages: StreamMessage[] = [];
      const ws = new WebSocket(stream.url, streamProtocols(stream.token));
      sockets.push(ws);
      ws.on('message', (data) => {
        messages.push(streamMessageSchema.parse(JSON.parse(String(data))));
      });
      await vi.waitFor(() => expect(messages[0]?.type).toBe('snapshot'));
      return messages;
    };

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'qd-workspace-api-'));
      for (const name of ['deck', 'other']) {
        await mkdir(join(homeDir, 'work', name, '.git'), { recursive: true });
      }
      api = await startApiServer({ port: 0, homeDir });
    }, TIMEOUT);

    afterEach(async () => {
      sockets.splice(0).forEach((ws) => ws.terminate());
      await Promise.all(served.splice(0).map((stream) => stream.close()));
      await api.close();
      await rm(homeDir, { recursive: true, force: true });
    }, TIMEOUT);

    it('starts single, then switches to multi with a notice when a second repository is created', async () => {
      const deckPath = join(homeDir, 'work', 'deck');
      const first = await send('project.create', {
        project: 'deck',
        repoPath: deckPath,
      });
      expect(first.body).toMatchObject({
        result: { workspace: { mode: 'single', notice: null } },
      });
      const read = await send('workspace.read', {});
      expect(read.body).toMatchObject({
        result: { workspace: { mode: 'single', root: deckPath } },
      });

      const messages = await listen('deck');
      const [snapshot] = messages;
      expect(snapshot?.type === 'snapshot' && snapshot.workspace?.mode).toBe(
        'single',
      );

      const second = await send('project.create', {
        project: 'other',
        repoPath: join(homeDir, 'work', 'other'),
      });
      expect(second.body).toMatchObject({
        result: {
          workspace: {
            mode: 'multi',
            notice:
              'Workspace switched to multi mode: it now has 2 repositories, and each one is a project.',
          },
        },
      });
      await vi.waitFor(() => {
        const frames = messages.flatMap((message) => {
          if (message.type !== 'workspace') return [];
          return [message.workspace.mode];
        });
        expect(frames).toEqual(['multi']);
      });
      expect(
        (await readWorkspace(api.stores.dataHome))?.projects.map(
          ({ slug }) => slug,
        ),
      ).toEqual(['deck', 'other']);
    });

    it('drops a wiped project from the workspace', async () => {
      await send('project.create', {
        project: 'deck',
        repoPath: join(homeDir, 'work', 'deck'),
      });
      await send('wipe.project', { project: 'deck', confirm: 'deck' });
      expect((await readWorkspace(api.stores.dataHome))?.projects).toEqual([]);
    });
  },
);
