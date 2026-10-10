export interface FieldText {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface ListMarker {
  prefix: string;
  indent: string;
  next: string;
}

export type IndentDirection = 'indent' | 'outdent';

export const LIST_INDENT = '  ';
export const UNCHECKED_BOX = '[ ]';

const BULLET_ITEM = /^([ \t]*)([-*•][ \t]+)(\[[ xX]\][ \t]+)?/;
const NUMBERED_ITEM = /^([ \t]*)(\d{1,9})([.)][ \t]+)/;
const LEADING_SPACES = new RegExp(`^ {1,${LIST_INDENT.length}}`);

const nextBullet = (bullet: string, box: string | undefined): string => {
  if (box === undefined) return bullet;
  return `${bullet}${UNCHECKED_BOX}${box.slice(UNCHECKED_BOX.length)}`;
};

const bulletMarker = (line: string): ListMarker | null => {
  const match = BULLET_ITEM.exec(line);
  if (match === null) return null;
  const [prefix, indent = '', bullet = '', box] = match;
  return { prefix, indent, next: `${indent}${nextBullet(bullet, box)}` };
};

const numberedMarker = (line: string): ListMarker | null => {
  const match = NUMBERED_ITEM.exec(line);
  if (match === null) return null;
  const [prefix, indent = '', number = '', delimiter = ''] = match;
  const next = Number.parseInt(number, 10) + 1;
  return { prefix, indent, next: `${indent}${next}${delimiter}` };
};

export const listMarker = (line: string): ListMarker | null =>
  bulletMarker(line) ?? numberedMarker(line);

interface Line {
  start: number;
  end: number;
  text: string;
}

const lineStart = (value: string, index: number): number => {
  if (index === 0) return 0;
  return value.lastIndexOf('\n', index - 1) + 1;
};

const lineEnd = (value: string, index: number): number => {
  const newline = value.indexOf('\n', index);
  if (newline === -1) return value.length;
  return newline;
};

const lineAt = (value: string, index: number): Line => {
  const start = lineStart(value, index);
  const end = lineEnd(value, index);
  return { start, end, text: value.slice(start, end) };
};

interface ListLine extends Line {
  marker: ListMarker;
}

const listLineAt = ({
  value,
  selectionStart,
  selectionEnd,
}: FieldText): ListLine | null => {
  const line = lineAt(value, selectionStart);
  if (selectionEnd > line.end) return null;
  const marker = listMarker(line.text);
  if (marker === null) return null;
  return { ...line, marker };
};

const isEmptyItem = ({ text, marker }: ListLine): boolean =>
  text.slice(marker.prefix.length).trim() === '';

export const continueList = (field: FieldText): TextEdit | null => {
  const line = listLineAt(field);
  if (line === null) return null;
  if (field.selectionStart < line.start + line.marker.prefix.length) {
    return null;
  }
  if (isEmptyItem(line)) return { start: line.start, end: line.end, text: '' };
  return {
    start: field.selectionStart,
    end: field.selectionEnd,
    text: `\n${line.marker.next}`,
  };
};

const outdentWidth = (indent: string): number => {
  if (indent.startsWith('\t')) return 1;
  return LEADING_SPACES.exec(indent)?.[0].length ?? 0;
};

export const indentList = (
  field: FieldText,
  direction: IndentDirection,
): TextEdit | null => {
  const line = listLineAt(field);
  if (line === null) return null;
  const { value, selectionEnd } = field;
  if (direction === 'indent') {
    const text = `${LIST_INDENT}${value.slice(line.start, selectionEnd)}`;
    return { start: line.start, end: selectionEnd, text };
  }
  const width = outdentWidth(line.marker.indent);
  if (width === 0) return null;
  const end = Math.max(selectionEnd, line.start + width);
  return { start: line.start, end, text: value.slice(line.start + width, end) };
};
