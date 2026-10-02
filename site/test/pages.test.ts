import { existsSync, readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC,
  SVG_NAMESPACE,
  TEXT_EXTENSIONS,
  crossOriginUrls,
  htmlPages,
  ids,
  localLinks,
  pageText,
  publicFiles,
  readPage,
} from './pages.js';

describe('every page', () => {
  it('walks every html, css and svg file it serves', () => {
    const extensions = new Set(publicFiles.map((path) => extname(path)));
    expect(extensions).toEqual(new Set(TEXT_EXTENSIONS));
  });

  it.each(htmlPages)('%s runs no scripts', (page) => {
    expect(readPage(page)).not.toMatch(/<script/i);
  });

  it.each(htmlPages)('%s carries the Kiro trademark notice', (page) => {
    expect(pageText(readPage(page))).toContain(
      'not affiliated with or endorsed by Amazon',
    );
  });

  it.each(publicFiles.map((path) => relative(PUBLIC, path)))(
    '%s loads nothing from another origin',
    (path) => {
      expect(crossOriginUrls(readPage(path))).toEqual([]);
    },
  );

  it.each([
    "@import url('https://fonts.googleapis.com/css2?family=Inter');",
    '<link rel="stylesheet" href=\'https://cdn.example.com/x.css\' />',
    '<img src=https://tracker.example.com/p.gif>',
    '<img srcset="//cdn.example.com/a.png 2x" />',
    `<svg xmlns="${SVG_NAMESPACE}"><image href="http://x.example/a.png" /></svg>`,
    '<code><img src="//cdn.example.com/a.png" /></code>',
    '<code id="x">https://cdn.example.com/a.css</code>',
  ])('the origin check catches %s', (probe) => {
    expect(crossOriginUrls(probe)).not.toEqual([]);
  });

  it('the origin check lets a command name a URL as code text', () => {
    expect(
      crossOriginUrls('<code>curl -fsSL https://cli.kiro.dev/install</code>'),
    ).toEqual([]);
  });

  it.each(htmlPages)('%s links only to files and ids that exist', (page) => {
    localLinks(page).forEach((link) => {
      expect(existsSync(link.file), link.url).toBe(true);
      if (link.fragment === undefined) return;
      expect(ids(readFileSync(link.file, 'utf8')), link.url).toContain(
        link.fragment,
      );
    });
  });
});
