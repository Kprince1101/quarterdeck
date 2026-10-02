import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_DIR } from '@quarterdeck/rules';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATES = ['charter.md', 'reviewer.md'];
const NAME_SOURCES = ['LICENSE.md', 'TRADEMARK.md'];
const NAMES = ['Kristopher Prince', 'Amazon.com, Inc.'];
const LEGAL_SUFFIXES = new Set(['Inc', 'LLC', 'Ltd', 'Corp']);

const read = (path: string) => readFileSync(path, 'utf8');

const readTemplate = (file: string) => read(resolve(DEFAULT_RULES_DIR, file));

const nameWords = (name: string) =>
  name
    .split(/[^A-Za-z]+/)
    .filter((word) => /^[A-Z][a-z]+$/.test(word) && !LEGAL_SUFFIXES.has(word));

const mentions = (text: string, word: string) =>
  new RegExp(`\\b${word}\\b`, 'i').test(text);

describe('charter and reviewer templates', () => {
  it.each(NAMES)('%s is named in LICENSE.md or TRADEMARK.md', (name) => {
    const sources = NAME_SOURCES.map((file) => read(resolve(ROOT, file)));
    expect(sources.some((text) => text.includes(name))).toBe(true);
  });

  describe.each(TEMPLATES)('%s', (file) => {
    it.each(NAMES)('does not mention %s', (name) => {
      const text = readTemplate(file);
      for (const word of nameWords(name)) {
        expect(mentions(text, word), `${file} mentions "${word}"`).toBe(false);
      }
    });
  });

  it('charter covers every crew role and human gate', () => {
    const charter = readTemplate('charter.md');
    for (const term of [
      'Planner',
      'Driver',
      'Builders',
      'Reviewer',
      'Merge gate',
      'card',
      'notebook',
    ]) {
      expect(charter).toContain(term);
    }
  });

  it('reviewer prompt ends in a verdict on the bus', () => {
    const reviewer = readTemplate('reviewer.md');
    expect(reviewer).toContain('`verdict`');
    expect(reviewer).toMatch(/Approve/);
    expect(reviewer).toMatch(/Request changes/);
  });
});
