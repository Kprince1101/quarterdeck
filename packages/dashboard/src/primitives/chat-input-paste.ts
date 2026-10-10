export interface PasteData {
  readonly types: readonly string[];
  getData: (format: string) => string;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const LINE_BREAK = String.fromCodePoint(0xe000);
const PARAGRAPH_BREAK = String.fromCodePoint(0xe001);
const BREAKS = `${LINE_BREAK}${PARAGRAPH_BREAK}`;
const BREAK_RUN = new RegExp(`[ \\t]*[${BREAKS}][ \\t${BREAKS}]*`, 'g');

const SKIPPED_TAGS = new Set([
  'HEAD',
  'NOSCRIPT',
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
]);
const CELL_TAGS = new Set(['TD', 'TH']);
const LINE_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FOOTER',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'SECTION',
  'TR',
]);
const PARAGRAPH_TAGS = new Set([
  'BLOCKQUOTE',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'UL',
]);

const textNodeText = (node: Node, preformatted: boolean): string => {
  const text = node.textContent ?? '';
  if (preformatted) return text;
  return text.replace(/\s+/g, ' ');
};

const wrap = (tag: string, inner: string): string => {
  if (PARAGRAPH_TAGS.has(tag)) {
    return `${PARAGRAPH_BREAK}${inner}${PARAGRAPH_BREAK}`;
  }
  if (LINE_TAGS.has(tag)) return `${LINE_BREAK}${inner}${LINE_BREAK}`;
  if (CELL_TAGS.has(tag)) return `${inner}\t`;
  return inner;
};

const textOf = (node: Node, preformatted: boolean): string => {
  if (node.nodeType === TEXT_NODE) return textNodeText(node, preformatted);
  if (node.nodeType !== ELEMENT_NODE) return '';
  const tag = node.nodeName;
  if (SKIPPED_TAGS.has(tag)) return '';
  if (tag === 'BR') return '\n';
  const inside = preformatted || tag === 'PRE';
  const inner = Array.from(node.childNodes, (child) =>
    textOf(child, inside),
  ).join('');
  return wrap(tag, inner);
};

const breakFor = (run: string): string => {
  if (run.includes(PARAGRAPH_BREAK)) return '\n\n';
  return '\n';
};

export const htmlToText = (html: string): string => {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  return textOf(body, false)
    .replaceAll(NO_BREAK_SPACE, ' ')
    .replace(BREAK_RUN, breakFor)
    .trim();
};

const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n?/g, '\n');

export const pastedText = (data: PasteData | null): string | null => {
  if (data === null) return null;
  const plain = normalizeNewlines(data.getData('text/plain'));
  if (plain !== '') return plain;
  if (!data.types.includes('text/html')) return null;
  const text = htmlToText(data.getData('text/html'));
  if (text === '') return null;
  return text;
};
