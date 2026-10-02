import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULE_NAMES, loadRules } from '@quarterdeck/rules';

const ROOT = resolve(import.meta.dirname, '../..');
const ENTRY_SCRIPT = [
  "const { loadRules } = await import('@quarterdeck/rules');",
  'const rules = await loadRules({ homeDir: process.argv[1] });',
  'process.stdout.write(JSON.stringify(rules));',
].join('\n');

describe('@quarterdeck/rules package entry', () => {
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(resolve(tmpdir(), 'quarterdeck-entry-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('loads the rules from plain Node', async () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', ENTRY_SCRIPT, homeDir],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(await loadRules({ homeDir }));
  });

  it('exposes the schemas alone from plain Node', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { RULE_SCHEMAS } = await import('@quarterdeck/rules/schemas');\nprocess.stdout.write(JSON.stringify(Object.keys(RULE_SCHEMAS)));",
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(RULE_NAMES);
  });

  it('exposes the layer merge alone from plain Node', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { mergeLayer } = await import('@quarterdeck/rules/merge');\nprocess.stdout.write(JSON.stringify(mergeLayer({ a: 1, b: { c: 2 } }, { b: { c: 3 } })));",
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ a: 1, b: { c: 3 } });
  });

  it('exposes the shell warnings alone from plain Node', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { shellAllowWarnings } = await import('@quarterdeck/rules/shell-warnings');\nprocess.stdout.write(JSON.stringify(shellAllowWarnings({ default: 'ask', rules: [{ kind: 'execute', pattern: '*', decision: 'allow' }] })));",
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([
      'execute allow "*" permits any command.',
    ]);
  });
});
