import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../src/widgets/rules/line-diff.js';

const ops = (before: string, after: string): string[] =>
  lineDiff(before, after).map(({ op, text }) => `${op} ${text}`);

describe('lineDiff', () => {
  it('keeps unchanged lines and marks the changed ones', () => {
    expect(ops('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      'same a',
      'remove b',
      'add B',
      'same c',
    ]);
  });

  it('shows a new file as all additions and a removal as all removals', () => {
    expect(ops('', '{\n}\n')).toEqual(['add {', 'add }']);
    expect(ops('x\ny', '')).toEqual(['remove x', 'remove y']);
  });

  it('finds the longest common run between edits', () => {
    expect(ops('a\nb\nc\nd', 'b\nc\nx\nd')).toEqual([
      'remove a',
      'same b',
      'same c',
      'add x',
      'same d',
    ]);
  });

  it('ignores a missing final newline', () => {
    expect(ops('a\n', 'a')).toEqual(['same a']);
  });

  it('gives every line a unique id', () => {
    const ids = lineDiff('a\nb\nc', 'c\nb\na').map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
