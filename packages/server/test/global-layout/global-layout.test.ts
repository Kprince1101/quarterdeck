import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startApiServer, type ApiServer } from '../../src/api/index.js';
import {
  createGlobalLayouts,
  globalLayoutPath,
  readGlobalLayout,
  writeGlobalLayout,
} from '../../src/global-layout/index.js';
import { LAYOUT_PRESETS, type GridLayout } from '../../src/layouts/index.js';
import { quarterdeckHome } from '../../src/store/index.js';
import {
  serveStream,
  streamMessageSchema,
  streamProtocols,
  type ServedStream,
  type StreamMessage,
} from '../../src/stream/index.js';
import { bearer, readReply } from '../api/harness.js';

const TIMEOUT = 30_000;

const BOARD_ONLY: GridLayout = {
  columns: 12,
  rows: 12,
  items: [
    { id: 'board-1', widget: 'board', x: 0, y: 0, w: 12, h: 12, hidden: false },
  ],
};

interface Client {
  ws: WebSocket;
  messages: StreamMessage[];
}

const connect = (served: ServedStream): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(served.url, streamProtocols(served.token));
    const client: Client = { ws, messages: [] };
    ws.on('message', (data) => {
      client.messages.push(streamMessageSchema.parse(JSON.parse(String(data))));
    });
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });

const snapshotLayout = async (client: Client): Promise<unknown> => {
  await vi.waitFor(() => expect(client.messages[0]?.type).toBe('snapshot'));
  const [first] = client.messages;
  if (first?.type !== 'snapshot') throw new Error('no snapshot');
  return first.layout?.spec ?? null;
};

const layoutFrames = (client: Client): unknown[] =>
  client.messages.flatMap((message) => {
    if (message.type !== 'layout') return [];
    return [message.layout.spec];
  });

describe('global layout file', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-layout-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is absent until written, then reads back what was written', async () => {
    expect(await readGlobalLayout(join(home, 'missing'))).toBeNull();
    const written = await writeGlobalLayout(join(home, 'qd'), BOARD_ONLY);
    expect(written.spec).toEqual(BOARD_ONLY);
    expect(await readGlobalLayout(join(home, 'qd'))).toEqual(written);
  });

  it('is private to the user', async () => {
    const qd = join(home, 'qd');
    await writeGlobalLayout(qd, BOARD_ONLY);
    expect((await stat(qd)).mode & 0o777).toBe(0o700);
    expect((await stat(globalLayoutPath(qd))).mode & 0o777).toBe(0o600);
  });

  it('reads nothing from a file the grid could not show', async () => {
    await writeFile(globalLayoutPath(home), '{ "spec": { "columns": 12 } }');
    expect(await readGlobalLayout(home)).toBeNull();
    await writeFile(globalLayoutPath(home), 'not json');
    expect(await readGlobalLayout(home)).toBeNull();
  });

  it('refuses to write a layout the grid could not show', async () => {
    const outside = { ...BOARD_ONLY, rows: 4 };
    await expect(writeGlobalLayout(home, outside)).rejects.toThrow();
    expect(await readGlobalLayout(home)).toBeNull();
  });

  it('tells subscribers about each save, in order', async () => {
    const layouts = createGlobalLayouts(home);
    const heard: GridLayout[] = [];
    const stop = layouts.subscribe(({ spec }) => heard.push(spec));
    await Promise.all([
      layouts.save(BOARD_ONLY),
      layouts.save(LAYOUT_PRESETS.ops),
    ]);
    stop();
    await layouts.save(LAYOUT_PRESETS.minimal);
    expect(heard).toEqual([BOARD_ONLY, LAYOUT_PRESETS.ops]);
    expect((await layouts.read())?.spec).toEqual(LAYOUT_PRESETS.minimal);
  });
});

describe('global layout through the API', { timeout: TIMEOUT }, () => {
  let homeDir: string;
  let api: ApiServer;
  const served: ServedStream[] = [];
  const clients: Client[] = [];

  const send = async (name: string, body: unknown) =>
    readReply(
      await fetch(`${api.url}/api/intents/${name}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...bearer(api.token) },
      }),
    );

  const streamFor = async (project: string): Promise<Client> => {
    const stream = await serveStream({
      store: await api.stores.get(project),
      home: api.stores.dataHome,
      layouts: api.layouts,
      token: api.token,
    });
    served.push(stream);
    const client = await connect(stream);
    clients.push(client);
    return client;
  };

  const dashboardRows = async (project: string) => {
    const store = await api.stores.get(project);
    const { rows } = await store.db.query<{ spec: unknown }>(
      `select spec from layouts where name = 'dashboard'`,
    );
    return rows.map(({ spec }) => spec);
  };

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-layout-api-'));
    api = await startApiServer({ port: 0, homeDir });
    await send('project.create', { project: 'deck' });
    await send('project.create', { project: 'other' });
  }, TIMEOUT);

  afterEach(async () => {
    clients.splice(0).forEach(({ ws }) => ws.terminate());
    await Promise.all(served.splice(0).map((stream) => stream.close()));
    await api.close();
    await rm(homeDir, { recursive: true, force: true });
  }, TIMEOUT);

  it('saves the dashboard layout once and every project reads it back', async () => {
    const deck = await streamFor('deck');
    const other = await streamFor('other');
    expect(await snapshotLayout(deck)).toBeNull();
    expect(await snapshotLayout(other)).toBeNull();

    const saved = await send('layout.save', {
      name: 'dashboard',
      spec: BOARD_ONLY,
    });
    expect(saved).toMatchObject({
      status: 200,
      body: { id: null, result: { name: 'dashboard' } },
    });
    await vi.waitFor(() => {
      expect(layoutFrames(deck)).toEqual([BOARD_ONLY]);
      expect(layoutFrames(other)).toEqual([BOARD_ONLY]);
    });
    expect((await readGlobalLayout(api.stores.dataHome))?.spec).toEqual(
      BOARD_ONLY,
    );
    expect(await dashboardRows('deck')).toEqual([]);
    expect(await dashboardRows('other')).toEqual([]);

    expect(await snapshotLayout(await streamFor('deck'))).toEqual(BOARD_ONLY);
    expect(await snapshotLayout(await streamFor('other'))).toEqual(BOARD_ONLY);
  });

  it('resets the dashboard layout to a preset for every project', async () => {
    const other = await streamFor('other');
    await snapshotLayout(other);
    const reset = await send('layout.reset', {
      name: 'dashboard',
      preset: 'ops',
    });
    expect(reset).toMatchObject({
      status: 200,
      body: { id: null, result: { name: 'dashboard', preset: 'ops' } },
    });
    await vi.waitFor(() => {
      expect(layoutFrames(other)).toEqual([LAYOUT_PRESETS.ops]);
    });
    const unknown = await send('layout.reset', {
      name: 'dashboard',
      preset: 'cockpit',
    });
    expect(unknown.status).toBe(400);
  });

  it('keeps the project requirement for every other layout', async () => {
    const withProject = await send('layout.save', {
      project: 'deck',
      name: 'dashboard',
      spec: BOARD_ONLY,
    });
    expect(withProject.status).toBe(400);
    const withoutProject = await send('layout.save', {
      name: 'spare',
      spec: BOARD_ONLY,
    });
    expect(withoutProject.status).toBe(400);
    const spare = await send('layout.save', {
      project: 'deck',
      name: 'spare',
      spec: BOARD_ONLY,
    });
    expect(spare).toMatchObject({
      status: 200,
      body: { result: { name: 'spare', layoutId: expect.any(String) } },
    });
    expect(await readGlobalLayout(api.stores.dataHome)).toBeNull();
  });

  it('refuses a dashboard layout the grid could not show', async () => {
    const res = await send('layout.save', {
      name: 'dashboard',
      spec: { ...BOARD_ONLY, rows: 4 },
    });
    expect(res.status).toBe(400);
    expect(await readGlobalLayout(api.stores.dataHome)).toBeNull();
  });
});

describe('seeding the global layout at startup', { timeout: TIMEOUT }, () => {
  let homeDir: string;

  const insertDashboard = async (
    api: ApiServer,
    project: string,
    spec: unknown,
    updatedAt: string,
  ): Promise<void> => {
    const store = await api.stores.get(project);
    await store.db.query(
      `insert into layouts (project_id, name, spec, updated_at)
       values ($1, 'dashboard', $2::jsonb, $3)`,
      [store.projectId, JSON.stringify(spec), updatedAt],
    );
  };

  const restart = () =>
    startApiServer({ port: 0, homeDir, openProjects: true });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-layout-seed-'));
    const api = await startApiServer({ port: 0, homeDir });
    const create = (project: string) =>
      fetch(`${api.url}/api/intents/project.create`, {
        method: 'POST',
        body: JSON.stringify({ project }),
        headers: { 'content-type': 'application/json', ...bearer(api.token) },
      });
    await create('deck');
    await create('other');
    await create('broken');
    await insertDashboard(api, 'deck', BOARD_ONLY, '2026-01-01T00:00:00Z');
    await insertDashboard(
      api,
      'other',
      LAYOUT_PRESETS.ops,
      '2026-06-01T00:00:00Z',
    );
    await insertDashboard(
      api,
      'broken',
      { columns: 12 },
      '2026-09-01T00:00:00Z',
    );
    await api.close();
  }, TIMEOUT);

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('makes the newest project dashboard layout the global one and keeps the rows', async () => {
    const home = quarterdeckHome(homeDir);
    expect(await readGlobalLayout(home)).toBeNull();
    const api = await restart();
    try {
      expect((await readGlobalLayout(home))?.spec).toEqual(LAYOUT_PRESETS.ops);
      const deck = await api.stores.get('deck');
      const { rows } = await deck.db.query<{ spec: unknown }>(
        `select spec from layouts where name = 'dashboard'`,
      );
      expect(rows.map(({ spec }) => spec)).toEqual([BOARD_ONLY]);
    } finally {
      await api.close();
    }
  });

  it('seeds only when there is no global layout yet', async () => {
    const home = quarterdeckHome(homeDir);
    await writeGlobalLayout(home, LAYOUT_PRESETS.minimal);
    const api = await restart();
    await api.close();
    expect((await readGlobalLayout(home))?.spec).toEqual(
      LAYOUT_PRESETS.minimal,
    );
  });
});
