import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { KEEP_AWAKE_NOT_SERVED } from '../../src/api/handlers/keep-awake.js';
import { keepAwakePath } from '../../src/keep-awake/index.js';
import {
  startQuarterdeck,
  type Quarterdeck,
} from '../../src/quarterdeck/index.js';
import { quarterdeckHome } from '../../src/store/index.js';
import {
  STREAM_PATH,
  streamMessageSchema,
  streamProtocols,
  type KeepAwakeState,
  type StreamMessage,
} from '../../src/stream/index.js';
import { VOYAGE_ENDED_EVENT } from '../../src/voyage-end/index.js';
import { bearer, readReply, startTestApi, type Reply } from '../api/harness.ts';
import {
  AVAILABLE,
  MISSING,
  fakeSpawner,
  type FakeSpawner,
} from '../keep-awake/fake-hold.ts';

const TIMEOUT = 60_000;
const PROJECT = 'example';
const OWNER = 1234;
const HOUR_MS = 60 * 60 * 1000;

interface StreamClient {
  ws: WebSocket;
  frames: StreamMessage[];
}

const openStreamClient = (qd: Quarterdeck): Promise<StreamClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${qd.port}${STREAM_PATH}`,
      streamProtocols(qd.token),
    );
    const frames: StreamMessage[] = [];
    ws.on('message', (data) => {
      frames.push(streamMessageSchema.parse(JSON.parse(String(data))));
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });

const send = async (
  qd: Quarterdeck,
  name: string,
  body: unknown,
): Promise<Reply> =>
  readReply(
    await fetch(`${qd.url}/api/intents/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(qd.token) },
      body: JSON.stringify(body),
    }),
  );

const keepAwakeFrames = (client: StreamClient): KeepAwakeState[] =>
  client.frames.flatMap((frame) => {
    if (frame.type === 'keepAwake') return [frame.keepAwake];
    if (frame.type === 'snapshot' && frame.keepAwake) return [frame.keepAwake];
    return [];
  });

const latest = (client: StreamClient): KeepAwakeState | undefined =>
  keepAwakeFrames(client).at(-1);

const OFF: KeepAwakeState = {
  on: false,
  mode: null,
  expiresAt: null,
  available: true,
  unavailableReason: null,
};

describe('keep-awake intents', { timeout: TIMEOUT }, () => {
  let homeDir = '';
  let fake: FakeSpawner;
  const running: Quarterdeck[] = [];

  const start = async (
    support = AVAILABLE('caffeinate'),
  ): Promise<Quarterdeck> => {
    const qd = await startQuarterdeck({
      port: 0,
      homeDir,
      keepAwake: {
        platform: 'darwin',
        ownerPid: OWNER,
        spawn: fake.spawn,
        support,
      },
    });
    running.push(qd);
    return qd;
  };

  const openProject = async (qd: Quarterdeck): Promise<StreamClient> => {
    expect(
      (await send(qd, 'project.create', { project: PROJECT })).status,
    ).toBe(200);
    const client = await openStreamClient(qd);
    await vi.waitFor(() => expect(client.frames[0]?.type).toBe('snapshot'));
    return client;
  };

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-keep-awake-'));
    fake = fakeSpawner();
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((qd) => qd.close()));
    await rm(homeDir, { recursive: true, force: true });
  });

  it('starts, shows on with expiresAt on the stream, then stops', async () => {
    const qd = await start();
    const client = await openProject(qd);
    expect(client.frames[0]).toMatchObject({ keepAwake: OFF });

    const before = Date.now();
    const started = await send(qd, 'keepAwake.start', { minutes: 60 });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      intent: 'keepAwake.start',
      status: 'applied',
      id: null,
      result: { keepAwake: { on: true, mode: 'duration' } },
    });
    expect(fake.commands).toEqual([
      {
        command: 'caffeinate',
        args: ['-i', '-t', '3600', '-w', String(OWNER)],
      },
    ]);
    await vi.waitFor(() =>
      expect(latest(client)).toMatchObject({ on: true, mode: 'duration' }),
    );
    const expiresAt = Date.parse(latest(client)?.expiresAt ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + HOUR_MS);
    expect(existsSync(keepAwakePath(quarterdeckHome(homeDir)))).toBe(true);

    const stopped = await send(qd, 'keepAwake.stop', {});
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ result: { keepAwake: OFF } });
    await vi.waitFor(() => expect(latest(client)).toEqual(OFF));
    expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
    expect(existsSync(keepAwakePath(quarterdeckHome(homeDir)))).toBe(false);
    client.ws.terminate();
  });

  it('turns "until voyage ends" off on the voyage end event', async () => {
    const qd = await start();
    const client = await openProject(qd);

    expect(
      (await send(qd, 'keepAwake.start', { untilVoyageEnds: true })).status,
    ).toBe(200);
    expect(fake.commands[0]).toEqual({
      command: 'caffeinate',
      args: ['-i', '-w', String(OWNER)],
    });
    await vi.waitFor(() =>
      expect(latest(client)).toMatchObject({
        on: true,
        mode: 'untilVoyageEnds',
        expiresAt: null,
      }),
    );

    const services = qd.projects.get(PROJECT);
    await services?.store.publish({
      kind: VOYAGE_ENDED_EVENT,
      payload: { voyage: 1, reason: 'killed' },
    });

    await vi.waitFor(() => expect(latest(client)).toEqual(OFF));
    expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
    client.ws.terminate();
  });

  it('tells every tab, and releases the hold on shutdown', async () => {
    const qd = await start();
    const first = await openProject(qd);
    const second = await openStreamClient(qd);

    await send(qd, 'keepAwake.start', { minutes: 120 });
    await vi.waitFor(() => {
      expect(latest(first)).toMatchObject({ on: true });
      expect(latest(second)).toMatchObject({ on: true });
    });

    await qd.close();
    expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
    expect(existsSync(keepAwakePath(quarterdeckHome(homeDir)))).toBe(false);
  });

  it('starts off after a restart', async () => {
    const first = await start();
    await send(first, 'keepAwake.start', { untilVoyageEnds: true });
    await first.close();

    const second = await start();
    const client = await openProject(second);
    expect(client.frames[0]).toMatchObject({ keepAwake: OFF });
    expect(fake.commands).toHaveLength(1);
    client.ws.terminate();
  });

  it('refuses with the reason when the tool is missing', async () => {
    const qd = await start(MISSING('caffeinate'));
    const client = await openProject(qd);
    const reason =
      'caffeinate is not on PATH, so Quarterdeck cannot keep this computer awake.';
    expect(client.frames[0]).toMatchObject({
      keepAwake: { on: false, available: false, unavailableReason: reason },
    });

    const refused = await send(qd, 'keepAwake.start', { minutes: 30 });
    expect(refused).toMatchObject({ status: 409, body: { error: reason } });
    expect(fake.commands).toEqual([]);
    client.ws.terminate();
  });

  it('rejects a start with neither a duration nor untilVoyageEnds', async () => {
    const qd = await start();
    expect((await send(qd, 'keepAwake.start', {})).status).toBe(400);
    expect(
      (
        await send(qd, 'keepAwake.start', {
          minutes: 30,
          untilVoyageEnds: true,
        })
      ).status,
    ).toBe(400);
    expect((await send(qd, 'keepAwake.start', { minutes: 0 })).status).toBe(
      400,
    );
  });

  it('is refused by an API server that does not own a keep-awake', async () => {
    const api = await startTestApi();
    try {
      expect(await api.send('keepAwake.start', { minutes: 30 })).toMatchObject({
        status: 409,
        body: { error: KEEP_AWAKE_NOT_SERVED },
      });
    } finally {
      await api.close();
    }
  });
});
