import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_DIR } from '@quarterdeck/rules';
import { PRIVATE_NAME_HASHES, hashName, namesIn } from './private-names.js';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATES = [
  'charter.md',
  'reviewer.md',
  'profiles/default/standards.md',
  'profiles/default/profile.json',
];
const NAME_SOURCES = ['LICENSE.md', 'TRADEMARK.md'];

const MID_SENTENCE_CAPITALISED = /(?<=[a-z0-9,'"(/-] *)\b[A-Z][A-Za-z0-9]*\b/g;

const PRODUCT_NAME_HASHES = [
  'f776fd61b1a82d656202fd35560dbd3be548d43cf1418d9cd6e2b154304c8c37',
  'c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131',
  'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
  '5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6',
  'bbdefa2950f49882f295b1285d4fa9dec45fc4144bfb07ee6acc68762d12c2e3',
  '49f756463ad9dcfb9b6ade54d7d6f15476e7214f46a65b4b0c55d46845b12f70',
  '10182ab855ff772753c05b2fea333666b5f312835d32936b6b03e08ef2cbd6d3',
  'a942b37ccfaf5a813b1432caa209a43b9d144e47ad0de1549c289c253e556cd5',
  '969545dde1584d88227517c6a0c969eb716015671cd6be053b3aaf14d85aa8c8',
  '9d3508a8484ee2520ca5fe0e52eab835774efa3fe533267e914eb00ad78d2579',
  '7ce54cbababdd64826b853179905315617306f430e5154177ddbed04c282b7da',
];

const CAPITALISED_BUT_NOT_NAMES = new Set([
  'Quarterdeck',
  'Software',
  'Inc',
  'LICENSE',
]);

const PROBE =
  "You are the Driver of Amazon's Quarterdeck crew, running on Kiro and Claude for the Vercel Postgres repo.";

const read = (path: string) => readFileSync(path, 'utf8');

const readTemplate = (file: string) => read(resolve(DEFAULT_RULES_DIR, file));

const withoutAllCapsLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => /[a-z]/.test(line))
    .join('\n');

const sourceNames = () =>
  NAME_SOURCES.flatMap(
    (file) =>
      withoutAllCapsLines(read(resolve(ROOT, file))).match(
        MID_SENTENCE_CAPITALISED,
      ) ?? [],
  ).filter((name) => !CAPITALISED_BUT_NOT_NAMES.has(name));

const NAME_HASHES: ReadonlySet<string> = new Set([
  ...PRIVATE_NAME_HASHES,
  ...PRODUCT_NAME_HASHES,
  ...sourceNames().map(hashName),
]);

const leaks = (text: string) =>
  [...new Set(namesIn(text, NAME_HASHES))].toSorted();

describe('charter and reviewer templates', () => {
  it('takes the copyright holder and trademark owners from the sources', () => {
    const holder =
      /^Copyright \(c\) \d+ (.+)$/m.exec(
        read(resolve(ROOT, 'LICENSE.md')),
      )?.[1] ?? '';
    expect(holder).not.toBe('');
    expect(leaks(holder)).toEqual(holder.split(' ').toSorted());
    expect(leaks('Kiro is a trademark of Amazon')).toEqual(['Amazon', 'Kiro']);
  });

  it('flags every name in a leaky charter line', () => {
    expect(leaks(PROBE)).toEqual([
      'Amazon',
      'Claude',
      'Kiro',
      'Postgres',
      'Vercel',
    ]);
  });

  it('flags every private name', () => {
    expect(
      [...PRIVATE_NAME_HASHES].filter((hash) => !NAME_HASHES.has(hash)),
    ).toEqual([]);
  });

  it('matches names case-insensitively on word boundaries', () => {
    expect(leaks('run on KIRO with gemini')).toEqual(['KIRO', 'gemini']);
    expect(leaks('a Kiroless, Claudeish crew')).toEqual([]);
  });

  it.each(TEMPLATES)('%s names no person, company or product', (file) => {
    expect(leaks(readTemplate(file))).toEqual([]);
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
      'charter_proposals',
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
