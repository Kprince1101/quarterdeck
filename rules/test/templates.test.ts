import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_DIR } from '@quarterdeck/rules';
import { PRIVATE_NAMES } from './private-names.js';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATES = ['charter.md', 'reviewer.md'];
const NAME_SOURCES = ['SPEC.md', 'LICENSE.md', 'TRADEMARK.md'];

const MID_SENTENCE_CAPITALISED = /(?<=[a-z0-9,'"(/-] *)\b[A-Z][A-Za-z0-9]*\b/g;

const NAMES_NOT_CAPITALISED_IN_SOURCES = [
  'harness',
  'Claude',
  'Anthropic',
  'Google',
];

const QUARTERDECK_VOCABULARY = new Set([
  'Quarterdeck',
  'Planner',
  'Driver',
  'Agent',
  'Agents',
  'Project',
  'Tickets',
  'Cards',
  'Notebook',
  'Rules',
  'Data',
]);

const REQUIRED_NAMES = [
  'harness',
  'Vercel',
  'Amazon',
  'Anthropic',
  'Google',
  'Kiro',
  'Claude',
  'Gemini',
  'Kristopher',
  'Prince',
];

const PROBE =
  "You are the Driver of Amazon's Quarterdeck crew, running on Kiro and Claude for the Vercel harness repo.";

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
  );

const byLowerCase = (names: string[]) =>
  new Map(names.map((name) => [name.toLowerCase(), name])).values();

const NAMES = [
  ...byLowerCase([
    ...PRIVATE_NAMES,
    ...NAMES_NOT_CAPITALISED_IN_SOURCES,
    ...sourceNames(),
  ]),
]
  .filter((name) => !QUARTERDECK_VOCABULARY.has(name))
  .toSorted();

const leaks = (text: string) =>
  NAMES.filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(text));

describe('charter and reviewer templates', () => {
  it('derives every required name from the sources', () => {
    expect(NAMES).toEqual(expect.arrayContaining(REQUIRED_NAMES));
  });

  it('flags every name in a leaky charter line', () => {
    expect(leaks(PROBE)).toEqual([
      'Amazon',
      'Claude',
      'Kiro',
      'Vercel',
      'harness',
    ]);
  });

  it('flags every private name', () => {
    const flagged = leaks(PRIVATE_NAMES.join(' ').toUpperCase());
    expect(flagged.map((name) => name.toLowerCase()).toSorted()).toEqual(
      PRIVATE_NAMES.toSorted(),
    );
  });

  it('matches names case-insensitively on word boundaries', () => {
    expect(leaks('run on KIRO with gemini')).toEqual(['Gemini', 'Kiro']);
    expect(leaks('a harnessed Kiroless crew')).toEqual([]);
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
