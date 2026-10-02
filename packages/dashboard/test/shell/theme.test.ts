import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS, token, tokenVar } from '../../src/theme/tokens.js';

const SRC = resolve(import.meta.dirname, '../../src');
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8');

const TOKENS_CSS = read('theme/tokens.css');
const STYLESHEETS = [
  'theme/tokens.css',
  'shell/shell.css',
  'widgets/widgets.css',
];

const defined = [...TOKENS_CSS.matchAll(/(--qd-[\w-]+)\s*:/g)].map(
  ([, name]) => name,
);

const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

describe('theme tokens', () => {
  it('defines every token in tokens.css, and nothing else', () => {
    expect(defined.toSorted()).toEqual(TOKENS.map(tokenVar).toSorted());
  });

  it('names a token as a CSS variable', () => {
    expect(token('accent')).toBe('var(--qd-accent)');
  });

  it.each(STYLESHEETS)('%s only uses defined tokens', (path) => {
    const used = [...read(path).matchAll(/var\((--qd-[\w-]+)\)/g)].map(
      ([, name]) => name,
    );
    expect(used.length).toBeGreaterThan(0);
    used.forEach((name) => expect(defined).toContain(name));
  });

  it('is dark', () => {
    expect(rule(TOKENS_CSS, ':root')).toContain('color-scheme: dark;');
  });
});

describe('layout', () => {
  const shell = read('shell/shell.css');

  it('fills the viewport and never scrolls the page', () => {
    expect(TOKENS_CSS).toMatch(/body\s*{[^}]*overflow: hidden;/);
    const frame = rule(shell, '.qd-shell');
    expect(frame).toContain('height: 100dvh;');
    expect(frame).toContain('overflow: hidden;');
  });

  it('lets the workspace shrink to the space under the header', () => {
    expect(rule(shell, '.qd-shell')).toContain(
      'grid-template-rows: var(--qd-header-height) minmax(0, 1fr);',
    );
    expect(rule(shell, '.qd-workspace')).toContain('min-height: 0;');
  });

  it('scrolls each panel body on its own', () => {
    expect(rule(shell, '.qd-panel')).toContain('overflow: hidden;');
    const body = rule(shell, '.qd-panel-body');
    expect(body).toContain('overflow: auto;');
    expect(body).toContain('min-height: 0;');
    expect(body).toContain('overscroll-behavior: contain;');
  });
});
