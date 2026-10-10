// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  htmlToText,
  pastedText,
  type PasteData,
} from '../../src/primitives/index.js';

const clipboard = (data: Record<string, string>): PasteData => ({
  types: Object.keys(data),
  getData: (format) => data[format] ?? '',
});

describe('htmlToText', () => {
  it('strips markup and keeps the text', () => {
    expect(htmlToText('<b>bold</b> and <a href="x">a link</a>')).toBe(
      'bold and a link',
    );
  });

  it('keeps line breaks from paragraphs, blocks and <br>', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('<div>one</div><div>two</div>')).toBe('one\ntwo');
    expect(htmlToText('one<br>two')).toBe('one\ntwo');
    expect(htmlToText('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>')).toBe('a\nb');
  });

  it('collapses source whitespace but keeps preformatted text', () => {
    expect(htmlToText('<p>  spread\n   out  </p>')).toBe('spread out');
    expect(htmlToText('<pre>a\n  b</pre>')).toBe('a\n  b');
  });

  it('drops styles and scripts', () => {
    expect(
      htmlToText(
        '<style>p { color: red }</style><p>text</p><script>x()</script>',
      ),
    ).toBe('text');
  });
});

describe('pastedText', () => {
  it('prefers the plain text and normalises line endings', () => {
    expect(
      pastedText(
        clipboard({ 'text/plain': 'one\r\ntwo', 'text/html': '<b>rich</b>' }),
      ),
    ).toBe('one\ntwo');
  });

  it('falls back to the HTML stripped to text', () => {
    expect(pastedText(clipboard({ 'text/html': '<p>one</p><p>two</p>' }))).toBe(
      'one\n\ntwo',
    );
  });

  it('leaves a paste with no text to the browser', () => {
    expect(pastedText(clipboard({ Files: '' }))).toBeNull();
    expect(
      pastedText(clipboard({ 'text/html': '<img src="x.png">' })),
    ).toBeNull();
    expect(pastedText(null)).toBeNull();
  });
});
