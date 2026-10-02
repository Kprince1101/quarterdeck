export type GlobMode = 'path' | 'command';

const REGEX_SPECIAL = /[.+^${}()|[\]\\/]/g;

const STAR_SOURCE: Record<GlobMode, string> = {
  path: '[^/]*',
  command: '[\\s\\S]*',
};

const QUESTION_SOURCE: Record<GlobMode, string> = {
  path: '[^/]',
  command: '[\\s\\S]',
};

const escapeLiteral = (text: string): string =>
  text.replace(REGEX_SPECIAL, '\\$&');

const tokenSource = (
  pattern: string,
  index: number,
  mode: GlobMode,
): [string, number] => {
  const char = pattern.charAt(index);
  if (char === '?') return [QUESTION_SOURCE[mode], 1];
  if (char !== '*') return [escapeLiteral(char), 1];
  if (pattern.charAt(index + 1) !== '*') return [STAR_SOURCE[mode], 1];
  if (pattern.charAt(index + 2) === '/') return ['(?:[\\s\\S]*/)?', 3];
  return ['[\\s\\S]*', 2];
};

export const globSource = (pattern: string, mode: GlobMode): string => {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const [part, width] = tokenSource(pattern, index, mode);
    source += part;
    index += width;
  }
  return `^${source}$`;
};

export const compileGlob = (pattern: string, mode: GlobMode): RegExp =>
  new RegExp(globSource(pattern, mode));

export const matchesGlob = (
  pattern: string,
  subject: string,
  mode: GlobMode,
): boolean => compileGlob(pattern, mode).test(subject);
