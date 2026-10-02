import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRules } from '@quarterdeck/rules';

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
});
