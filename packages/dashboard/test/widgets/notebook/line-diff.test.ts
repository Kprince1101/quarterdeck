import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../../src/widgets/notebook/line-diff.js';

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
  });

  it('marks every line added against empty text', () => {
    expect(marked('', 'one\ntwo')).toEqual(['added:one', 'added:two']);
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

  it('gives each line a distinct id in order', () => {
    expect(lineDiff('a\nb', 'b\nc').map(({ id }) => id)).toEqual([0, 1, 2]);
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
