import { describe, expect, it } from 'vitest';
import {
  continueList,
  indentList,
  listMarker,
  type FieldText,
  type TextEdit,
} from '../../src/primitives/index.js';

const CARET = '|';

const field = (marked: string): FieldText => {
  const start = marked.indexOf(CARET);
  const end = marked.lastIndexOf(CARET) - 1;
  const value = marked.replaceAll(CARET, '');
  if (start === end + 1) {
    return { value, selectionStart: start, selectionEnd: start };
  }
  return { value, selectionStart: start, selectionEnd: end };
};

const applied = (before: FieldText, edit: TextEdit | null): string | null => {
  if (edit === null) return null;
  const { value } = before;
  const caret = edit.start + edit.text.length;
  return `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`
    .split('')
    .toSpliced(caret, 0, CARET)
    .join('');
};

const shiftEnter = (marked: string): string | null => {
  const before = field(marked);
  return applied(before, continueList(before));
};

const tab = (marked: string): string | null => {
  const before = field(marked);
  return applied(before, indentList(before, 'indent'));
};

const shiftTab = (marked: string): string | null => {
  const before = field(marked);
  return applied(before, indentList(before, 'outdent'));
};

describe('continueList', () => {
  it('continues a numbered list from the current number', () => {
    expect(shiftEnter('3. third|')).toBe('3. third\n4. |');
    expect(shiftEnter('1. one\n2. two|')).toBe('1. one\n2. two\n3. |');
  });

  it('keeps the numbering style', () => {
    expect(shiftEnter('1) one|')).toBe('1) one\n2) |');
    expect(shiftEnter('9. nine|')).toBe('9. nine\n10. |');
  });

  it('repeats each bullet', () => {
    expect(shiftEnter('- dash|')).toBe('- dash\n- |');
    expect(shiftEnter('* star|')).toBe('* star\n* |');
    expect(shiftEnter('• dot|')).toBe('• dot\n• |');
  });

  it('starts every new task unchecked', () => {
    expect(shiftEnter('- [ ] open|')).toBe('- [ ] open\n- [ ] |');
    expect(shiftEnter('- [x] done|')).toBe('- [x] done\n- [ ] |');
    expect(shiftEnter('- [X] done|')).toBe('- [X] done\n- [ ] |');
  });

  it('keeps the indent of a nested item', () => {
    expect(shiftEnter('- top\n  - nested|')).toBe('- top\n  - nested\n  - |');
    expect(shiftEnter('\t2. tabbed|')).toBe('\t2. tabbed\n\t3. |');
  });

  it('carries the text after the caret into the next item', () => {
    expect(shiftEnter('- left|right')).toBe('- left\n- |right');
  });

  it('replaces a selection with the next item', () => {
    expect(shiftEnter('- keep|drop|')).toBe('- keep\n- |');
  });

  it('ends the list on an empty item by removing its marker', () => {
    expect(shiftEnter('1. one\n2. |')).toBe('1. one\n|');
    expect(shiftEnter('- one\n- |\nafter')).toBe('- one\n|\nafter');
    expect(shiftEnter('- [ ] |')).toBe('|');
    expect(shiftEnter('  * |')).toBe('|');
  });

  it('leaves lines that are not list items alone', () => {
    expect(shiftEnter('plain|')).toBeNull();
    expect(shiftEnter('-5 degrees|')).toBeNull();
    expect(shiftEnter('1.5 hours|')).toBeNull();
    expect(shiftEnter('**bold**|')).toBeNull();
    expect(shiftEnter('- item\nplain|')).toBeNull();
  });

  it('leaves a caret before the marker, or a selection across lines, alone', () => {
    expect(shiftEnter('|- item')).toBeNull();
    expect(shiftEnter('- it|em\n- ne|xt')).toBeNull();
  });
});

describe('indentList', () => {
  it('indents a list line wherever the caret is in it', () => {
    expect(tab('- item|')).toBe('  - item|');
    expect(tab('1. it|em')).toBe('  1. it|em');
    expect(tab('- one\n- two|')).toBe('- one\n  - two|');
  });

  it('outdents a list line by one step', () => {
    expect(shiftTab('    - deep|')).toBe('  - deep|');
    expect(shiftTab('  - item|')).toBe('- item|');
    expect(shiftTab(' - item|')).toBe('- item|');
    expect(shiftTab('\t- item|')).toBe('- item|');
  });

  it('keeps the caret on the line when it sits inside the indent', () => {
    expect(shiftTab('|  - item')).toBe('|- item');
  });

  it('does nothing to an item with no indent left', () => {
    expect(shiftTab('- item|')).toBeNull();
  });

  it('leaves lines that are not list items to Tab focus', () => {
    expect(tab('plain|')).toBeNull();
    expect(shiftTab('  plain|')).toBeNull();
  });
});

describe('listMarker', () => {
  it('reads the marker and the one that follows it', () => {
    expect(listMarker('  12) item')).toEqual({
      prefix: '  12) ',
      indent: '  ',
      next: '  13) ',
    });
    expect(listMarker('* [x] done')).toEqual({
      prefix: '* [x] ',
      indent: '',
      next: '* [ ] ',
    });
    expect(listMarker('plain')).toBeNull();
  });
});
