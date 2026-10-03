import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { forgeReadResultSchema } from '../../src/intents/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const exec = promisify(execFile);

const project = 'forge';

describe('forge.read', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let repoDir = '';

  const setOrigin = async (origin: string): Promise<void> => {
    await exec('git', ['-C', repoDir, 'remote', 'remove', 'origin']).catch(
      () => undefined,
    );
    await exec('git', ['-C', repoDir, 'remote', 'add', 'origin', origin]);
  };

  const read = async () => {
    const res = await t.send('forge.read', { project });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'forge.read',
      status: 'applied',
      id: null,
    });
    return forgeReadResultSchema.parse(res.body.result);
  };

  beforeAll(async () => {
    t = await startTestApi();
    repoDir = await mkdtemp(join(tmpdir(), 'qd-forge-repo-'));
    await exec('git', ['init', '-q', repoDir]);
    await t.send('project.create', { project, repoPath: repoDir });
  }, TIMEOUT);

  afterEach(async () => {
    await rm(join(t.homeDir, '.quarterdeck', 'rules.local.forges.json'), {
      force: true,
    });
  });

  afterAll(async () => {
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('reads GitHub and its terms for a github.com origin', async () => {
    await setOrigin('git@github.com:example-org/forge.git');

    expect(await read()).toEqual({
      forge: 'github',
      terms: { short: 'PR', long: 'pull request', cli: 'gh', name: 'GitHub' },
    });
  });

  it('reads GitLab and its terms for a mapped self-hosted origin', async () => {
    await mkdir(join(t.homeDir, '.quarterdeck'), { recursive: true });
    await writeFile(
      join(t.homeDir, '.quarterdeck', 'rules.local.forges.json'),
      JSON.stringify({ forges: { 'git.example.org': 'gitlab' } }),
    );
    await setOrigin('https://git.example.org/example-org/forge.git');

    expect(await read()).toEqual({
      forge: 'gitlab',
      terms: {
        short: 'MR',
        long: 'merge request',
        cli: 'glab',
        name: 'GitLab',
      },
    });
  });

  it('answers 409 naming an unmapped host', async () => {
    await setOrigin('https://git.example.org/example-org/forge.git');

    const res = await t.send('forge.read', { project });

    expect(res.status).toBe(409);
    expect(res.body['error']).toContain(
      'git.example.org is not a forge Quarterdeck knows',
    );
  });
});
