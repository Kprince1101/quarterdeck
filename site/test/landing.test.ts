import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TEXT_EXTENSIONS = ['.html', '.css', '.svg'];
const publicFiles = readdirSync(PUBLIC, { recursive: true, encoding: 'utf8' })
  .map((path) => resolve(PUBLIC, path))
  .filter((path) => statSync(path).isFile())
  .filter((path) => TEXT_EXTENSIONS.includes(extname(path)));

const crossOriginUrls = (source: string): string[] =>
  source.replaceAll(SVG_NAMESPACE, '').match(/(https?:)?\/\/[^\s'"()<>]*/g) ??
  [];

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

  it('runs no scripts', () => {
    expect(html).not.toMatch(/<script/i);
  });

  it('walks every html, css and svg file it serves', () => {
    const extensions = new Set(publicFiles.map((path) => extname(path)));
    expect(extensions).toEqual(new Set(TEXT_EXTENSIONS));
  });

  it.each(publicFiles.map((path) => relative(PUBLIC, path)))(
    '%s loads nothing from another origin',
    (path) => {
      expect(
        crossOriginUrls(readFileSync(resolve(PUBLIC, path), 'utf8')),
      ).toEqual([]);
    },
  );

  it.each([
    "@import url('https://fonts.googleapis.com/css2?family=Inter');",
    '<link rel="stylesheet" href=\'https://cdn.example.com/x.css\' />',
    '<img src=https://tracker.example.com/p.gif>',
    '<img srcset="//cdn.example.com/a.png 2x" />',
    `<svg xmlns="${SVG_NAMESPACE}"><image href="http://x.example/a.png" /></svg>`,
  ])('the origin check catches %s', (probe) => {
    expect(crossOriginUrls(probe)).not.toEqual([]);
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
