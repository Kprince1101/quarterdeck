// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FAKE_WEBSOCKET, FakeSocket } from './api/fake-socket.js';
import { page, textOf } from './shell/page.js';

const DASHBOARD = resolve(import.meta.dirname, '..');
const DIST = resolve(DASHBOARD, 'dist');
const INDEX = resolve(DIST, 'index.html');

const assets = (html: string): string[] =>
  [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    ([, path]) => path ?? '',
  );

describe('dashboard build', () => {
  const html = readFileSync(INDEX, 'utf8');

  afterAll(() => {
    vi.unstubAllGlobals();
    FakeSocket.opened = [];
  });

  it('writes index.html and its hashed assets to packages/dashboard/dist', () => {
    const paths = assets(html);
    expect(paths.some((path) => path.endsWith('.js'))).toBe(true);
    expect(paths.some((path) => path.endsWith('.css'))).toBe(true);
    paths.forEach((path) => {
      expect(path).toMatch(/^\/assets\/[\w-]+\.(js|css)$/);
      expect(existsSync(resolve(DIST, `.${path}`))).toBe(true);
    });
  });

  it('boots the built bundle into #root and opens the stream at /ws', async () => {
    const script = assets(html).find((path) => path.endsWith('.js'));
    vi.stubGlobal('WebSocket', FAKE_WEBSOCKET);
    const { body } = page();
    body.innerHTML = '<div id="root"></div>';

    await import(resolve(DIST, `.${script ?? ''}`));

    await vi.waitFor(() => {
      expect(textOf(body, '#root .qd-brand')).toBe('Quarterdeck');
    });
    expect(body.querySelector('[data-widget-mount]')).not.toBeNull();
    expect(FakeSocket.opened.map(({ url }) => new URL(url).pathname)).toEqual([
      '/ws',
    ]);
  });
});
