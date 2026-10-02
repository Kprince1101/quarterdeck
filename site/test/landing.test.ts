import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUT, ROOT, SITE, localLinks, readPage, vercel } from './pages.js';

const html = readPage('index.html');
const text = html.replaceAll(/\s+/g, ' ');

describe('landing page', () => {
  it('leads with the README pitch', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    const pitch = readme.split('\n').find((line) => line.startsWith('Run a '));

    expect(pitch).toBeDefined();
    expect(text).toContain(pitch);
  });

  it('shows an install line that runs the published cli', () => {
    const cli = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/cli/package.json'), 'utf8'),
    ) as { name: string };

    expect(html).toContain(`<code id="install-line">npx ${cli.name} up</code>`);
  });

  it('has a screenshot slot', () => {
    expect(html).toMatch(/<figure[^>]*data-slot="screenshot"/);
  });

  it('links to the quickstart and the demo', () => {
    const urls = localLinks('index.html').map((link) => link.url);
    expect(urls).toContain('docs/quickstart.html');
    expect(urls).toContain('demo/');
  });
});

describe('vercel config', () => {
  it('installs at the workspace root and deploys the site build', () => {
    expect(vercel.framework).toBeNull();
    expect(vercel.installCommand).toBe('cd .. && npm ci');
    expect(vercel.buildCommand).toBe(
      `cd .. && npm run build --workspace ${basename(SITE)}`,
    );
    expect(OUT).toBe(resolve(SITE, 'dist'));
    expect(existsSync(resolve(OUT, 'index.html'))).toBe(true);
    expect(existsSync(resolve(OUT, 'demo/index.html'))).toBe(true);
  });
});
