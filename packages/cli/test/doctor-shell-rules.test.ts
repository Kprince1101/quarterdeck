import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkShellRules, main } from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const IS_WINDOWS = process.platform === 'win32';

const GIT_WARNING =
  'execute allow "git *" permits git with any arguments, which can run any code.';
const BASH_WARNING =
  'execute allow "bash *" permits bash, which can run any code.';

const executeAllow = (pattern: string) => ({
  kind: 'execute',
  pattern,
  decision: 'allow',
});

describe('quarterdeck doctor shell rules', () => {
  let box: Sandbox;
  let io: TestIo;

  const machineLayer = async (layer: unknown) => {
    const dir = join(box.home, '.quarterdeck');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'rules.local.permissions.json'),
      JSON.stringify(layer),
    );
  };

  beforeEach(async () => {
    box = await sandbox();
    io = testIo(box.home);
  });

  afterEach(async () => {
    await box.close();
  });

  it('says nothing about the shipped defaults', async () => {
    expect(await checkShellRules(io)).toEqual([]);
  });

  it('flags git * and bash * but not git status *', async () => {
    await machineLayer({
      rules: ['git status *', 'git *', 'bash *'].map(executeAllow),
    });

    expect(await checkShellRules(io)).toEqual([
      { name: 'permissions', state: GIT_WARNING, fixes: [] },
      { name: 'permissions', state: BASH_WARNING, fixes: [] },
    ]);
  });

  it('names the file when the machine layer is broken', async () => {
    await machineLayer({ rules: [{ kind: 'execute', decision: 'maybe' }] });

    const [check] = await checkShellRules(io);
    expect(check?.state).toContain(
      join(box.home, '.quarterdeck', 'rules.local.permissions.json'),
    );
  });

  it.skipIf(IS_WINDOWS)(
    'prints one line per broad rule after the tool checks',
    async () => {
      const bin = join(box.home, 'bin');
      await mkdir(bin);
      await machineLayer({ rules: [executeAllow('git *')] });

      expect(await main(['doctor'], { ...io, env: { PATH: bin } })).toBe(1);
      const blank = io.lines.indexOf('');
      expect(io.lines[blank - 1]).toBe(`permissions: ${GIT_WARNING}`);
      expect(
        io.lines.filter((line) => line.startsWith('permissions:')),
      ).toEqual([`permissions: ${GIT_WARNING}`]);
    },
  );
});
