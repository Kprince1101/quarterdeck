import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const TIMEOUT = 30_000;
const ENTRY_SCRIPT = [
  "const { openStore } = await import('@quarterdeck/server');",
  "const store = await openStore({ project: 'deck', home: process.argv[1] });",
  "const event = await store.publish({ kind: 'entry' });",
  'await store.close();',
  'process.stdout.write(JSON.stringify({ migrated: store.migrated, kind: event.kind }));',
].join('\n');

describe('@quarterdeck/server package entry', () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(resolve(tmpdir(), 'quarterdeck-server-entry-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it(
    'opens a migrated store from plain Node',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', ENTRY_SCRIPT, home],
        { cwd: ROOT, encoding: 'utf8' },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        migrated: ['0001_init'],
        kind: 'entry',
      });
    },
    TIMEOUT,
  );
});
