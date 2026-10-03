import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKiroBases } from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const writeJson = async (dir: string, file: string, value: unknown) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(value));
  return join(dir, file);
};

describe('quarterdeck doctor kiro base agents', () => {
  let box: Sandbox;
  let io: TestIo;

  const kiroRule = (dir: string, value: unknown) =>
    writeJson(join(dir, '.quarterdeck'), 'rules.local.kiro.json', value);

  const globalAgent = (name: string) =>
    writeJson(join(box.home, '.kiro', 'agents'), `${name}.json`, {});

  beforeEach(async () => {
    box = await sandbox();
    io = testIo(box.home);
  });

  afterEach(async () => {
    await box.close();
  });

  it('says nothing when no role has a base', async () => {
    expect(await checkKiroBases(io)).toEqual([]);
  });

  it('shows the base each role resolves to', async () => {
    const everyday = await globalAgent('everyday');
    await kiroRule(box.home, { baseAgents: { driver: 'everyday' } });

    expect(await checkKiroBases(io)).toEqual([
      {
        name: 'kiro base for driver',
        state: `everyday (${everyday})`,
        fixes: [],
      },
      { name: 'kiro base for reviewer', state: 'none', fixes: [] },
      { name: 'kiro base for builder', state: 'none', fixes: [] },
    ]);
  });

  it('shows the project builder from the repo it runs in', async () => {
    await globalAgent('everyday');
    const library = await writeJson(
      join(box.repo, '.kiro', 'agents'),
      'library-builder.json',
      {},
    );
    await kiroRule(box.home, { baseAgents: { builder: 'everyday' } });
    await kiroRule(box.repo, { baseAgents: { builder: 'library-builder' } });

    const checks = await checkKiroBases({ ...io, cwd: box.repo });

    expect(checks.at(-1)).toEqual({
      name: 'kiro base for builder',
      state: `library-builder (${library})`,
      fixes: [],
    });
  });

  it('names the missing file', async () => {
    await kiroRule(box.home, { baseAgents: { reviewer: 'security' } });

    const checks = await checkKiroBases(io);

    expect(checks[1]?.state).toContain(
      join(box.home, '.kiro', 'agents', 'security.json'),
    );
  });
});
