export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  id: number;
  kind: DiffKind;
  text: string;
}

interface CommonTails {
  at: (i: number, j: number) => number;
}

const linesOf = (text: string): string[] => {
  if (text === '') return [];
  return text.split('\n');
};

const commonTails = (before: string[], after: string[]): CommonTails => {
  const width = after.length + 1;
  const table = new Int32Array((before.length + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  const longest = (i: number, j: number): number => {
    if (before[i] === after[j]) return at(i + 1, j + 1) + 1;
    return Math.max(at(i + 1, j), at(i, j + 1));
  };
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = longest(i, j);
    }
  }
  return { at };
};

export const lineDiff = (beforeText: string, afterText: string): DiffLine[] => {
  const before = linesOf(beforeText);
  const after = linesOf(afterText);
  const { at } = commonTails(before, after);
  const lines: DiffLine[] = [];
  const push = (kind: DiffKind, text: string) => {
    lines.push({ id: lines.length, kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const removed = before[i] ?? '';
    const added = after[j] ?? '';
    if (removed === added) {
      push('same', removed);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push('removed', removed);
      i += 1;
    } else {
      push('added', added);
      j += 1;
    }
  }
  before.slice(i).forEach((text) => push('removed', text));
  after.slice(j).forEach((text) => push('added', text));
  return lines;
};
