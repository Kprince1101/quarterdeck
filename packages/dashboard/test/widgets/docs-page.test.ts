import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIDGETS } from '../../src/widgets/widgets.js';

const WIDGETS_PAGE = resolve(
  import.meta.dirname,
  '../../../../site/public/docs/widgets.html',
);

const sectionTitles = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) =>
    (match[1] ?? '').trim(),
  );

describe('widgets docs page', () => {
  it('has one section per registered widget, in registry order', () => {
    const titles = [...WIDGETS.values()].map(({ title }) => title);

    expect(titles.length).toBeGreaterThan(0);
    expect(sectionTitles(readFileSync(WIDGETS_PAGE, 'utf8'))).toEqual(titles);
  });
});
