import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRIVATE_NAME_HASHES,
  TOOLKIT,
  hashName,
  namesIn,
  privateNamesIn,
} from './private-names.js';

const ROOT = resolve(import.meta.dirname, '../..');
const TOOLKIT_DEPENDENCY_TREE = 'package-lock.json';
const NAME = TOOLKIT.split('-')[0] ?? '';
const CAPITALISED = NAME.charAt(0).toUpperCase() + NAME.slice(1);

const loadsToolkit = (file: string) => {
  const name = basename(file);
  return (
    name === 'package.json' ||
    name === '.oxlintrc.json' ||
    /^tsconfig(?:\..+)?\.json$/.test(name)
  );
};

const leaksIn = (file: string, text: string): string[] => {
  let scanned = text;
  if (loadsToolkit(file)) scanned = text.replaceAll(TOOLKIT, '');
  const leaks = privateNamesIn(file).map((name) => `${file}: ${name}`);
  for (const [index, line] of scanned.split('\n').entries())
    for (const name of privateNamesIn(line))
      leaks.push(`${file}:${index + 1}: ${name}`);
  return leaks;
};

const repoFiles = () =>
  execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (file) =>
        file !== '' &&
        file !== TOOLKIT_DEPENDENCY_TREE &&
        existsSync(resolve(ROOT, file)),
    );

const scanFile = (file: string): string[] => {
  const bytes = readFileSync(resolve(ROOT, file));
  if (bytes.includes(0)) return privateNamesIn(file);
  return leaksIn(file, bytes.toString('utf8'));
};

describe('clean room', () => {
  it('lists private names only as SHA-256 hashes', () => {
    expect(PRIVATE_NAME_HASHES.size).toBeGreaterThan(0);
    for (const hash of PRIVATE_NAME_HASHES)
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(PRIVATE_NAME_HASHES).toContain(hashName(NAME));
  });

  it('flags a private name in a test file, whatever its case', () => {
    const file = 'packages/server/test/gate/gate.test.ts';
    expect(leaksIn(file, `const ok = 1;\nname: '${CAPITALISED}'`)).toEqual([
      `${file}:2: ${CAPITALISED}`,
    ]);
    expect(leaksIn('docs.md', `see ${NAME.toUpperCase()}.`)).toHaveLength(1);
  });

  it('flags a private name in a file path', () => {
    expect(leaksIn(`docs/${NAME}.md`, '')).toEqual([
      `docs/${NAME}.md: ${NAME}`,
    ]);
  });

  it('matches whole words only', () => {
    expect(leaksIn('a.ts', `${NAME}Error({ ${NAME}s, x${NAME} })`)).toEqual([]);
  });

  it('matches a two-word name across whitespace only', () => {
    const names = new Set([hashName('harbor master')]);
    expect(namesIn('ask the Harbor\n  Master', names)).toEqual([
      'Harbor\n  Master',
    ]);
    expect(namesIn('harbor-master, harbor, master', names)).toEqual([]);
  });

  it('allows the toolkit dependency only in the files that load it', () => {
    const extend = `"extends": "${TOOLKIT}/tsconfig/node.json"`;
    expect(leaksIn('tsconfig.json', extend)).toEqual([]);
    expect(leaksIn('rules/tsconfig.build.json', extend)).toEqual([]);
    expect(leaksIn('package.json', `"${TOOLKIT}": "^0.5.0"`)).toEqual([]);
    expect(leaksIn('.oxlintrc.json', `./node_modules/${TOOLKIT}/x`)).toEqual(
      [],
    );
    expect(leaksIn('package.json', `"author": "${NAME}"`)).toHaveLength(1);
    expect(leaksIn('README.md', `uses ${TOOLKIT}`)).toHaveLength(1);
  });

  it('finds no private name in any repo file but the lockfile', () => {
    const files = repoFiles();
    expect(files).toContain('rules/test/clean-room.test.ts');
    expect(files).toContain('rules/test/private-names.ts');
    expect(files.flatMap((file) => scanFile(file))).toEqual([]);
  });
});
