import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_HOST,
  MAX_ATTACHMENT_BODY_BYTES,
  MAX_BODY_BYTES,
  type ApiServer,
} from '../../src/api/index.js';
import { TIMEOUT, bearer, startTestApi, type TestApi } from './harness.js';

const DASHBOARD_ORIGIN = 'http://localhost:5173';

const rawPost = (
  { port, token }: ApiServer,
  headers: Record<string, string>,
  body = '{}',
  intent = 'planner.message',
): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: API_HOST,
        port,
        method: 'POST',
        path: `/api/intents/${intent}`,
        headers: {
          'content-type': 'application/json',
          ...bearer(token),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end(body);
  });

describe('intent API guard', { timeout: TIMEOUT }, () => {
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
    expect(await rawPost(t.api, { host: 'evil.example' })).toBe(403);
    expect(await rawPost(t.api, { host: `localhost:${t.api.port}` })).toBe(400);
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
    const res = await fetch(`${t.api.url}/api/other`, {
      method: 'POST',
      headers: bearer(t.api.token),
    });
    expect(res.status).toBe(404);
    const unknown = await t.send('voyage.explode', {});
    expect(unknown).toMatchObject({
      status: 404,
      body: { error: 'Unknown intent voyage.explode' },
    });
  });

  it('only accepts POST', async () => {
    const res = await fetch(`${t.api.url}/api/intents/pause.set`, {
      headers: bearer(t.api.token),
    });
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
    const declared = await rawPost(
      t.api,
      {
        host: `127.0.0.1:${t.api.port}`,
        'content-length': String(MAX_BODY_BYTES + 1),
      },
      '{}',
      'pause.set',
    );
    expect(declared).toBe(413);
  });

  it('lets the intents that carry images send up to five 5 MB images', async () => {
    expect(MAX_ATTACHMENT_BODY_BYTES).toBeGreaterThan(
      5 * Math.ceil((5 * 1024 * 1024) / 3) * 4,
    );
    for (const intent of ['planner.message', 'card.answer']) {
      const declared = await rawPost(
        t.api,
        {
          host: `127.0.0.1:${t.api.port}`,
          'content-length': String(MAX_ATTACHMENT_BODY_BYTES + 1),
        },
        '{}',
        intent,
      );
      expect(declared).toBe(413);
    }
    const big = await t.send('planner.message', {
      project: 'ghost',
      text: 'x'.repeat(MAX_BODY_BYTES),
    });
    expect(big.status).toBe(400);
  });

  it('serves attachments only by a well-formed name', async () => {
    const read = (path: string) =>
      fetch(`${t.api.url}/api/attachments/${path}`, {
        headers: bearer(t.api.token),
      });
    expect((await read('deck/../../api.token')).status).toBe(404);
    expect((await read('deck/not-an-id.png')).status).toBe(404);
    expect((await read(`deck/${crypto.randomUUID()}.svg`)).status).toBe(404);
    expect((await read(`deck/${crypto.randomUUID()}.png`)).status).toBe(404);
    const posted = await fetch(
      `${t.api.url}/api/attachments/deck/${crypto.randomUUID()}.png`,
      { method: 'POST', headers: bearer(t.api.token) },
    );
    expect(posted.status).toBe(405);
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
