import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DASHBOARD_PLACEHOLDER,
  startApiServer,
  type ApiServer,
} from '../../src/api/index.js';

const INDEX = '<!doctype html><title>dashboard</title>';
const SCRIPT = 'console.log("dashboard");';

const rawGet = (port: number, path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });

describe('dashboard serving', () => {
  let root = '';
  let api: ApiServer;
  let bare: ApiServer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'qd-dashboard-'));
    const dist = join(root, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), INDEX);
    await writeFile(join(dist, 'assets', 'app.js'), SCRIPT);
    await writeFile(join(root, 'secret.txt'), 'outside the bundle');
    api = await startApiServer({ port: 0, homeDir: root, dashboardDir: dist });
    bare = await startApiServer({
      port: 0,
      homeDir: root,
      dashboardDir: join(root, 'missing'),
    });
  });

  afterAll(async () => {
    await api.close();
    await bare.close();
    await rm(root, { recursive: true, force: true });
  });

  it('serves index.html at the root and for app routes', async () => {
    for (const path of ['/', '/board/deck']) {
      const res = await fetch(`${api.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(await res.text()).toBe(INDEX);
    }
  });

  it('serves bundle files with their content type', async () => {
    const res = await fetch(`${api.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(await res.text()).toBe(SCRIPT);
  });

  it('answers 404 for a missing file rather than index.html', async () => {
    const res = await fetch(`${api.url}/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it('never serves a file outside the bundle', async () => {
    for (const path of ['/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const res = await fetch(`${api.url}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await fetch(`${api.url}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await fetch(`${api.url}/`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('applies the Host guard to dashboard requests', async () => {
    expect(await rawGet(api.port, '/', 'evil.example:80')).toBe(403);
    expect(await rawGet(api.port, '/', `localhost:${api.port}`)).toBe(200);
  });

  it('keeps /api routes on the API', async () => {
    const res = await fetch(`${api.url}/api/other`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No route for /api/other' });
  });

  it('serves a placeholder page when no dashboard is built', async () => {
    for (const path of ['/', '/board/deck']) {
      const res = await fetch(`${bare.url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DASHBOARD_PLACEHOLDER);
    }
    expect((await fetch(`${bare.url}/assets/app.js`)).status).toBe(404);
  });

  it('serves the placeholder when no dashboard dir is given', async () => {
    const plain = await startApiServer({ port: 0, homeDir: root });
    try {
      const res = await fetch(`${plain.url}/`);
      expect(await res.text()).toBe(DASHBOARD_PLACEHOLDER);
    } finally {
      await plain.close();
    }
  });
});
