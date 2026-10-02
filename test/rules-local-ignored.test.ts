import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const LOCAL_RULE_PATHS = [
  'rules.local.permissions.json',
  'rules/rules.local.charter.md',
  '.quarterdeck/rules.local.lifecycle.json',
  'packages/server/.quarterdeck/rules.local.models.json',
];
const SHIPPED_RULE_PATHS = ['rules/permissions.json', 'rules/charter.md'];

const isIgnored = (path: string) =>
  spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], {
    cwd: ROOT,
  }).status === 0;

describe('local rule files', () => {
  it.each(LOCAL_RULE_PATHS)('%s is gitignored', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each(SHIPPED_RULE_PATHS)('%s is tracked', (path) => {
    expect(isIgnored(path)).toBe(false);
  });
});
