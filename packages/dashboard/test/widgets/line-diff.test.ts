import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../src/widgets/line-diff.js';

const marked = (before: string, after: string): string[] =>
  lineDiff(before, after).map(({ kind, text }) => `${kind}:${text}`);

describe('lineDiff', () => {
  it('keeps unchanged lines and marks a replaced one', () => {
    expect(marked('a\nb\nc', 'a\nB\nc')).toEqual([
      'same:a',
      'removed:b',
      'added:B',
      'same:c',
    ]);
    expect(marked('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      'same:a',
      'removed:b',
      'added:B',
      'same:c',
    ]);
  });

  it('marks every line added against empty text', () => {
    expect(marked('', 'one\ntwo')).toEqual(['added:one', 'added:two']);
    expect(marked('', '{\n}\n')).toEqual(['added:{', 'added:}']);
  });

  it('marks every line removed when the new text is empty', () => {
    expect(marked('one\ntwo', '')).toEqual(['removed:one', 'removed:two']);
  });

  it('finds lines inserted and dropped around a common run', () => {
    expect(marked('x\na\nb', 'a\nb\ny')).toEqual([
      'removed:x',
      'same:a',
      'same:b',
      'added:y',
    ]);
  });

  it('finds the longest common run between edits', () => {
    expect(marked('a\nb\nc\nd', 'b\nc\nx\nd')).toEqual([
      'removed:a',
      'same:b',
      'same:c',
      'added:x',
      'same:d',
    ]);
  });

  it('ignores a missing final newline', () => {
    expect(marked('a\n', 'a')).toEqual(['same:a']);
  });

  it('gives each line a distinct id in order', () => {
    expect(lineDiff('a\nb', 'b\nc').map(({ id }) => id)).toEqual([
      '1:0',
      '2:1',
      '2:2',
    ]);
  });

  it('gives every line a unique id', () => {
    const ids = lineDiff('a\nb\nc', 'c\nb\na').map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rebuilds both texts from its lines', () => {
    const before = 'keep\nold\nkeep too\ngone';
    const after = 'new\nkeep\nkeep too\nnewer';
    const lines = lineDiff(before, after);
    const side = (drop: string) =>
      lines
        .filter(({ kind }) => kind !== drop)
        .map(({ text }) => text)
        .join('\n');
    expect(side('added')).toBe(before);
    expect(side('removed')).toBe(after);
  });
});
