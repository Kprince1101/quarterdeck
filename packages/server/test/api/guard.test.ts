import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_HOST, MAX_BODY_BYTES } from '../../src/api/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const DASHBOARD_ORIGIN = 'http://localhost:5173';

const rawPost = (
  port: number,
  headers: Record<string, string>,
): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: API_HOST,
        port,
        method: 'POST',
        path: '/api/intents/planner.message',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });

describe('intent API guard', () => {
  let t: TestApi;

  beforeAll(async () => {
    t = await startTestApi([DASHBOARD_ORIGIN]);
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
  });

  it('listens on 127.0.0.1 only', () => {
    expect(t.api.url).toBe(`http://127.0.0.1:${t.api.port}`);
  });

  it('refuses a Host header that is not this server', async () => {
    expect(await rawPost(t.api.port, { host: 'evil.example' })).toBe(403);
    expect(await rawPost(t.api.port, { host: `localhost:${t.api.port}` })).toBe(
      400,
    );
  });

  it('refuses a foreign Origin and allows a configured one', async () => {
    const foreign = await t.send(
      'planner.message',
      {},
      { headers: { 'content-type': 'application/json', origin: 'http://x.y' } },
    );
    expect(foreign.status).toBe(403);
    const allowed = await t.send(
      'planner.message',
      {},
      {
        headers: {
          'content-type': 'application/json',
          origin: DASHBOARD_ORIGIN,
        },
      },
    );
    expect(allowed.status).toBe(400);
  });

  it('answers 404 for unknown routes and intents', async () => {
    const res = await fetch(`${t.api.url}/api/other`, { method: 'POST' });
    expect(res.status).toBe(404);
    const unknown = await t.send('round.explode', {});
    expect(unknown).toMatchObject({
      status: 404,
      body: { error: 'Unknown intent round.explode' },
    });
  });

  it('only accepts POST', async () => {
    const res = await fetch(`${t.api.url}/api/intents/pause.set`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('requires a JSON content type and a JSON body', async () => {
    const plain = await t.send(
      'pause.set',
      {},
      { headers: { 'content-type': 'text/plain' } },
    );
    expect(plain.status).toBe(415);
    const broken = await t.send('pause.set', undefined, { body: '{nope' });
    expect(broken).toMatchObject({
      status: 400,
      body: { error: 'Body is not valid JSON' },
    });
  });

  it('refuses bodies over the size limit', async () => {
    const huge = await t.send('planner.message', {
      project: 'deck',
      text: 'x'.repeat(MAX_BODY_BYTES),
    });
    expect(huge.status).toBe(413);
  });

  it('returns zod issues for an invalid intent', async () => {
    const res = await t.send('pause.set', { project: 'Deck', paused: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid pause.set intent');
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['project'] }),
        expect.objectContaining({ path: ['paused'] }),
      ]),
    );
  });

  it('answers 404 for a project that was never created', async () => {
    const res = await t.send('pause.set', { project: 'ghost', paused: true });
    expect(res).toMatchObject({
      status: 404,
      body: { error: 'project ghost does not exist' },
    });
  });
});
