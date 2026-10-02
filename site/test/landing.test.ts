import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface VercelConfig {
  framework?: string | null;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
}

const SITE = resolve(import.meta.dirname, '..');
const ROOT = resolve(SITE, '..');
const vercel = JSON.parse(
  readFileSync(resolve(SITE, 'vercel.json'), 'utf8'),
) as VercelConfig;
const PUBLIC = resolve(SITE, vercel.outputDirectory ?? '');
const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const text = html.replaceAll(/\s+/g, ' ');

const attributeValues = (name: string): string[] =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(
    (match) => match[1] ?? '',
  );

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

  it('carries the Kiro trademark notice', () => {
    expect(text).toContain('not affiliated with or endorsed by Amazon');
  });

  it('loads nothing from another origin and runs no scripts', () => {
    expect(html).not.toMatch(/<script/i);
    [...attributeValues('href'), ...attributeValues('src')].forEach((url) =>
      expect(url).not.toMatch(/^(https?:)?\/\//),
    );
  });

  it('links only to files that exist', () => {
    [...attributeValues('href'), ...attributeValues('src')].forEach((url) =>
      expect(existsSync(resolve(PUBLIC, url))).toBe(true),
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
