export type DiffOp = 'same' | 'add' | 'remove';

export interface DiffLine {
  id: string;
  op: DiffOp;
  text: string;
}

type DiffEntry = Omit<DiffLine, 'id'>;

const MAX_TABLE_CELLS = 4_000_000;

const linesOf = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const tagged = (op: DiffOp, lines: readonly string[]): DiffEntry[] =>
  lines.map((text) => ({ op, text }));

const sharedPrefix = (a: readonly string[], b: readonly string[]): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
};

const sharedSuffix = (
  a: readonly string[],
  b: readonly string[],
  floor: number,
): number => {
  let n = 0;
  while (
    n < a.length - floor &&
    n < b.length - floor &&
    a[a.length - 1 - n] === b[b.length - 1 - n]
  ) {
    n += 1;
  }
  return n;
};

const lcsCell = (
  table: Uint32Array,
  a: readonly string[],
  b: readonly string[],
  at: { i: number; j: number; width: number },
): number => {
  const { i, j, width } = at;
  if (a[i] === b[j]) return (table[(i + 1) * width + j + 1] ?? 0) + 1;
  return Math.max(
    table[(i + 1) * width + j] ?? 0,
    table[i * width + j + 1] ?? 0,
  );
};

const lcsTable = (a: readonly string[], b: readonly string[]): Uint32Array => {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = lcsCell(table, a, b, { i, j, width });
    }
  }
  return table;
};

const walkTable = (a: readonly string[], b: readonly string[]): DiffEntry[] => {
  const table = lcsTable(a, b);
  const width = b.length + 1;
  const lines: DiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const before = a[i] ?? '';
    if (before === b[j]) {
      lines.push({ op: 'same', text: before });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      lines.push({ op: 'remove', text: before });
      i += 1;
    } else {
      lines.push({ op: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  return [
    ...lines,
    ...tagged('remove', a.slice(i)),
    ...tagged('add', b.slice(j)),
  ];
};

const middle = (a: readonly string[], b: readonly string[]): DiffEntry[] => {
  if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    return [...tagged('remove', a), ...tagged('add', b)];
  }
  return walkTable(a, b);
};

const numbered = (entries: readonly DiffEntry[]): DiffLine[] => {
  let before = 0;
  let after = 0;
  return entries.map((entry) => {
    if (entry.op !== 'add') before += 1;
    if (entry.op !== 'remove') after += 1;
    return { ...entry, id: `${before}:${after}` };
  });
};

export const lineDiff = (before: string, after: string): DiffLine[] => {
  const a = linesOf(before);
  const b = linesOf(after);
  const head = sharedPrefix(a, b);
  const tail = sharedSuffix(a, b, head);
  return numbered([
    ...tagged('same', a.slice(0, head)),
    ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...tagged('same', a.slice(a.length - tail)),
  ]);
};
