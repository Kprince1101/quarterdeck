import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  startQuarterdeck,
  type ProjectServices,
  type Quarterdeck,
} from '../../src/quarterdeck/index.js';
import {
  STREAM_PATH,
  streamMessageSchema,
  streamProtocols,
  type StreamMessage,
} from '../../src/stream/index.js';
import { bearer } from '../api/harness.ts';
import {
  callTool,
  connectStdio,
  insertAgent,
  type ToolReply,
} from '../bus/fixtures.ts';

const TIMEOUT = 60_000;
const PROJECT = 'example';

interface StreamClient {
  ws: WebSocket;
  frames: StreamMessage[];
}

const streamUrl = (qd: Quarterdeck, query = ''): string =>
  `ws://127.0.0.1:${qd.port}${STREAM_PATH}${query}`;

const openStreamClient = (url: string, token: string): Promise<StreamClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, streamProtocols(token));
    const frames: StreamMessage[] = [];
    ws.on('message', (data) => {
      frames.push(streamMessageSchema.parse(JSON.parse(String(data))));
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });

const upgradeStatus = (url: string, protocols: string[]): Promise<number> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, protocols);
    ws.once('unexpected-response', (_, response) => {
      resolve(response.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      resolve(101);
      ws.terminate();
    });
    ws.on('error', () => undefined);
  });

const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

const sendIntent = async (
  qd: Quarterdeck,
  name: string,
  body: unknown,
): Promise<number> => {
  const res = await fetch(`${qd.url}/api/intents/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(qd.token) },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
};

const servicesOf = (qd: Quarterdeck, project = PROJECT): ProjectServices => {
  const services = qd.projects.get(project);
  if (!services) throw new Error(`${project} has no services`);
  return services;
};

const busStatus = async (
  services: ProjectServices,
  agent: string,
): Promise<ToolReply> => {
  const { store, bus } = services;
  const agentId = await insertAgent(store, store.projectId, agent);
  const client = await connectStdio(await bus.launch(agentId));
  try {
    return await callTool(client, 'status', { text: 'on the bus' });
  } finally {
    await client.close();
  }
};

describe('startQuarterdeck', { timeout: TIMEOUT }, () => {
  let homeDir = '';
  const running: Quarterdeck[] = [];

  const start = async (): Promise<Quarterdeck> => {
    const qd = await startQuarterdeck({ port: 0, homeDir });
    running.push(qd);
    return qd;
  };

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-'));
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((qd) => qd.close()));
    await rm(homeDir, { recursive: true, force: true });
  });

  it('serves the stream and the bus, then closes them and frees the port', async () => {
    const qd = await start();
    expect(qd.projects.size).toBe(0);
    expect(await sendIntent(qd, 'project.create', { project: PROJECT })).toBe(
      200,
    );

    expect(await upgradeStatus(streamUrl(qd), [])).toBe(401);
    const client = await openStreamClient(streamUrl(qd), qd.token);
    await vi.waitFor(() => expect(client.frames[0]?.type).toBe('snapshot'));

    expect(
      await sendIntent(qd, 'notebook.add', { project: PROJECT, body: 'hello' }),
    ).toBe(200);
    await vi.waitFor(() =>
      expect(client.frames).toContainEqual(
        expect.objectContaining({
          type: 'change',
          table: 'notebook',
          op: 'insert',
          row: expect.objectContaining({ body: 'hello' }),
        }),
      ),
    );

    const services = servicesOf(qd);
    expect(await busStatus(services, 'okapi')).toEqual({
      text: 'noted',
      isError: false,
    });
    expect(existsSync(services.bus.socketPath)).toBe(true);

    const closed = new Promise<number>((resolve) => {
      client.ws.once('close', resolve);
    });
    await qd.close();

    expect(await closed).toBe(1001);
    expect(existsSync(services.bus.socketPath)).toBe(false);
    expect(qd.projects.size).toBe(0);
    expect(await portIsFree(qd.port)).toBe(true);
  });

  it('starts again after a clean stop and clears a stale bus socket', async () => {
    const first = await start();
    await sendIntent(first, 'project.create', { project: PROJECT });
    const { socketPath } = servicesOf(first).bus;
    await first.close();

    const second = await start();
    expect(servicesOf(second).bus.socketPath).toBe(socketPath);
    await second.close();

    await writeFile(socketPath, 'left by a crash');
    const third = await start();
    const services = servicesOf(third);
    expect(services.bus.socketPath).toBe(socketPath);
    expect(await busStatus(services, 'quetzal')).toEqual({
      text: 'noted',
      isError: false,
    });
    await third.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('routes the stream by project once more than one is open', async () => {
    const qd = await start();
    expect(await upgradeStatus(streamUrl(qd), streamProtocols(qd.token))).toBe(
      404,
    );
    await sendIntent(qd, 'project.create', { project: PROJECT });
    await sendIntent(qd, 'project.create', { project: 'sample' });

    expect(await upgradeStatus(streamUrl(qd), streamProtocols(qd.token))).toBe(
      400,
    );
    expect(
      await upgradeStatus(
        streamUrl(qd, '?project=missing'),
        streamProtocols(qd.token),
      ),
    ).toBe(404);
    expect(
      await upgradeStatus(
        streamUrl(qd, '?project=sample'),
        streamProtocols('x'),
      ),
    ).toBe(401);
    expect(
      await upgradeStatus(
        `ws://127.0.0.1:${qd.port}/elsewhere`,
        streamProtocols(qd.token),
      ),
    ).toBe(404);

    const client = await openStreamClient(
      streamUrl(qd, '?project=sample'),
      qd.token,
    );
    await vi.waitFor(() => expect(client.frames[0]?.type).toBe('snapshot'));
    const [snapshot] = client.frames;
    expect(snapshot).toMatchObject({
      tables: { projects: [expect.objectContaining({ slug: 'sample' })] },
    });
    client.ws.terminate();
  });

  it('stops a wiped project’s bus and stream', async () => {
    const qd = await start();
    await sendIntent(qd, 'project.create', { project: PROJECT });
    const { socketPath } = servicesOf(qd).bus;
    const client = await openStreamClient(streamUrl(qd), qd.token);
    const closed = new Promise<number>((resolve) => {
      client.ws.once('close', resolve);
    });

    expect(
      await sendIntent(qd, 'wipe.project', {
        project: PROJECT,
        confirm: PROJECT,
      }),
    ).toBe(200);

    expect(await closed).toBe(1001);
    expect(qd.projects.has(PROJECT)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });
});
