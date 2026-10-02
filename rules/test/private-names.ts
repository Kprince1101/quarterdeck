import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PRIVATE_NAME_HASHES: ReadonlySet<string> = new Set([
  'fc2dff6ac3e4ca52fececa9cbc19123217b572259ee9b83557fa8041381f799f',
  '613cdf23dd276b68fb7bb892488ff680e63e9e17e8c92b107cb007a92a055d00',
  '1614ceeec50a9336ebf690886caa747d6811c45d37086a3fa7b11c9e83926c6c',
  'bd1f01af915864c1ffb0481010175b8c2ac57d51a9f2357bdc95bf7187a10318',
  '0af0314a0d41115a67cf2384f8193b254accdf955d2efd883e77fab1464fe095',
  '4d7594e57f7d03f35ede2d316cda4cdb7df66b28963738e836a2f16d9fc9eb4d',
  'da62dfd88d3c7561df673e1409844014c4f94537f3c773e73a24ddfe6a3f218b',
]);

const TOOLKIT_HASH =
  '0a9cedbf93f6c541c8d57698139c14d566c7f69a83c3481614b2bb0c8221edaf';

const WORD = /\w+/g;
const WORD_PAIR = /^\w+\s+\w+$/;
const WHITESPACE = /\s+/g;

export const hashName = (name: string): string =>
  createHash('sha256')
    .update(name.replaceAll(WHITESPACE, ' ').toLowerCase())
    .digest('hex');

const wordsAndPairsIn = (text: string): string[] => {
  const words = [...text.matchAll(WORD)];
  return words.flatMap((word, index) => {
    const next = words[index + 1];
    if (next === undefined) return [word[0]];
    const pair = text.slice(word.index, next.index + next[0].length);
    if (!WORD_PAIR.test(pair)) return [word[0]];
    return [word[0], pair];
  });
};

export const namesIn = (text: string, names: ReadonlySet<string>): string[] =>
  wordsAndPairsIn(text).filter((candidate) => names.has(hashName(candidate)));

export const privateNamesIn = (text: string): string[] =>
  namesIn(text, PRIVATE_NAME_HASHES);

const rootPackage = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
) as { devDependencies: Record<string, string> };

const toolkit = Object.keys(rootPackage.devDependencies).find(
  (name) => hashName(name) === TOOLKIT_HASH,
);
if (toolkit === undefined)
  throw new Error('the root package.json no longer depends on the toolkit');

export const TOOLKIT = toolkit;
