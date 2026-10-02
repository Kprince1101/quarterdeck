import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC, ROOT, localLinks, readPage, vercel } from './pages.js';

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

  it('links to the quickstart', () => {
    expect(localLinks('index.html').map((link) => link.url)).toContain(
      'docs/quickstart.html',
    );
  });
});

describe('vercel config', () => {
  it('deploys the static folder with no install or build step', () => {
    expect(vercel.framework).toBeNull();
    expect(vercel.installCommand).toBe('');
    expect(vercel.buildCommand).toBe('');
    expect(existsSync(resolve(PUBLIC, 'index.html'))).toBe(true);
  });
});
