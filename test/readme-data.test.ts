import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_RULES_PREFIX } from '@quarterdeck/rules';
import { TURN_FILES, dataPaths } from '@quarterdeck/server';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');

const section = (heading: string): string => {
  const [, after = ''] = README.split(`\n## ${heading}\n`);
  const [body = ''] = after.split('\n## ');
  return body;
};

const SUFFIXES = { directory: '/', file: '', database: '' } as const;

describe('README: where your data lives', () => {
  const text = section('Where your data lives');

  it('says nothing leaves the machine', () => {
    expect(text).toContain('Nothing Quarterdeck stores leaves your machine.');
  });

  it.each(
    dataPaths({ homeDir: '/home/me', project: 'project', repoPath: '/repo' }),
  )('names $label ($scope)', ({ path, kind }) => {
    const documented = path
      .replace(/^\/home\/me\/\.quarterdeck\//, '')
      .replace(/^\/home\/me/, '~')
      .replace(/^\/repo/, '<repo>')
      .replace(/^project\//, '')
      .replace(/rules\.local\.[^/]+$/, `${LOCAL_RULES_PREFIX}<file>`);
    expect(text).toContain(`${documented}${SUFFIXES[kind]}`);
  });

  it.each(Object.values(TURN_FILES))('names the turn file %s', (file) => {
    expect(text).toContain(file);
  });

  it('names the folders and files outside ~/.quarterdeck', () => {
    expect(text).toContain('`<repo>/.quarterdeck/rules.local.<file>`');
    expect(text).toContain(
      '`~/.kiro/agents/quarterdeck-<project>-<agent>.json`',
    );
    expect(text).toContain('`DATABASE_URL`');
  });

  it('describes both wipes and what they need typed', () => {
    expect(text).toContain("**Wipe project** (type the project's name");
    expect(text).toContain('**Wipe everything** (type `wipe everything`)');
  });
});
