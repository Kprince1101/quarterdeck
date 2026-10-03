// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  OUT,
  PUBLIC,
  attributeValues,
  crossOriginUrls,
  publicFiles,
} from './pages.js';

const DEMO = resolve(OUT, 'demo');
const html = readFileSync(resolve(DEMO, 'index.html'), 'utf8');

const assets = attributeValues(html, 'src')
  .concat(attributeValues(html, 'href'))
  .filter((path) => /\.(js|css)$/.test(path));

const asset = (extension: string): string => {
  const path = assets.find((name) => name.endsWith(extension));
  if (path === undefined) throw new Error(`demo has no ${extension} asset`);
  return resolve(DEMO, path);
};

interface Body {
  innerHTML: string;
  querySelector: (selector: string) => { textContent: string | null } | null;
}

const body = (): Body =>
  (globalThis as unknown as { document: { body: Body } }).document.body;

const textOf = (selector: string): string | null | undefined =>
  body().querySelector(selector)?.textContent;

describe('demo build', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('writes demo/index.html with one script and one stylesheet beside it', () => {
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toMatch(/<script type="module"[^>]*src="[^"]+\.js"/);
    expect(assets).toHaveLength(2);
    assets.forEach((path) => {
      expect(dirname(resolve(DEMO, path))).toBe(resolve(DEMO, 'assets'));
      expect(readFileSync(resolve(DEMO, path), 'utf8').length).toBeGreaterThan(
        0,
      );
    });
  });

  it('copies every public file into the deploy unchanged', () => {
    publicFiles.forEach((path) => {
      const built = resolve(OUT, relative(PUBLIC, path));
      expect(readFileSync(built, 'utf8'), built).toBe(
        readFileSync(path, 'utf8'),
      );
    });
  });

  it('loads nothing from another origin', () => {
    expect(crossOriginUrls(html)).toEqual([]);
    expect(crossOriginUrls(readFileSync(asset('.css'), 'utf8'))).toEqual([]);
  });

  it('boots the dashboard labelled Demo and never opens a socket or a request', async () => {
    const network = vi.fn(() => {
      throw new Error('the demo touched the network');
    });
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('WebSocket', network);
    vi.stubGlobal('XMLHttpRequest', network);
    vi.stubGlobal('EventSource', network);
    body().innerHTML = '<div id="root"></div>';

    await import(asset('.js'));

    await vi.waitFor(() => {
      expect(textOf('#root .qd-brand')).toBe('Quarterdeck');
      expect(textOf('#root .qd-mode')).toBe('Demo');
      expect(textOf('#root [role="status"]')).toBe('Live');
    });
    await vi.waitFor(() => {
      expect(textOf('#root [aria-label="Board"]')).toContain('Voyage 2');
    });
    expect(network).not.toHaveBeenCalled();
  });
});
