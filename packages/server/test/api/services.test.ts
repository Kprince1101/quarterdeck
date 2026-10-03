import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { servicesReadResultSchema } from '../../src/intents/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const exec = promisify(execFile);

const MCP_TRACKER = {
  kind: 'tracker-mcp',
  how: 'mcp',
  server: 'tracker-mcp',
  notes: 'tickets are stories in the Example board',
} as const;

const CLI_TRACKER = {
  kind: 'tracker-cli',
  how: 'cli',
  command: 'tracker',
} as const;

describe('services intents', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let exampleRepo = '';
  let sampleRepo = '';

  const servicesLayer = () =>
    join(t.homeDir, '.quarterdeck', 'rules.local.services.json');

  const writeServicesLayer = async (value: unknown): Promise<void> => {
    await mkdir(join(t.homeDir, '.quarterdeck'), { recursive: true });
    await writeFile(servicesLayer(), JSON.stringify(value));
  };

  const read = async (project: string) => {
    const res = await t.send('services.read', { project });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'applied', id: null });
    return servicesReadResultSchema.parse(res.body.result);
  };

  const makeRepo = async (origin: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'qd-services-repo-'));
    await exec('git', ['init', '-q', dir]);
    await exec('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
    return dir;
  };

  beforeAll(async () => {
    t = await startTestApi();
    exampleRepo = await makeRepo('git@github.com:example-org/example.git');
    sampleRepo = await makeRepo('https://gitlab.com/example-org/sample.git');
    await t.send('project.create', {
      project: 'example',
      repoPath: exampleRepo,
    });
    await t.send('project.create', { project: 'sample', repoPath: sampleRepo });
  }, TIMEOUT);

  afterEach(async () => {
    await rm(servicesLayer(), { force: true });
    await t.send('services.set', {
      project: 'example',
      tracker: null,
      publishes: null,
    });
  });

  afterAll(async () => {
    await t.close();
    await rm(exampleRepo, { recursive: true, force: true });
    await rm(sampleRepo, { recursive: true, force: true });
  });

  it('reads the detected forge and host with no tracker set', async () => {
    expect(await read('example')).toEqual({
      forge: { forge: 'github', host: 'github.com', cli: 'gh', name: 'GitHub' },
      forgeError: null,
      tracker: null,
      trackerFrom: 'default',
      publishes: false,
      publishesFrom: 'default',
      rulesPath: servicesLayer(),
    });
    expect((await read('sample')).forge).toEqual({
      forge: 'gitlab',
      host: 'gitlab.com',
      cli: 'glab',
      name: 'GitLab',
    });
  });

  it('stores a tracker and publishes on the project and records the intent', async () => {
    const res = await t.send('services.set', {
      project: 'example',
      tracker: MCP_TRACKER,
      publishes: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'services.set',
      status: 'applied',
      result: { tracker: MCP_TRACKER, publishes: true },
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(await read('example')).toMatchObject({
      tracker: MCP_TRACKER,
      trackerFrom: 'project',
      publishes: true,
      publishesFrom: 'project',
    });
    expect(await read('sample')).toMatchObject({
      tracker: null,
      publishes: false,
    });
  });

  it('takes each project from the home rules layer, and a stored value wins', async () => {
    await writeServicesLayer({
      projects: {
        example: { tracker: CLI_TRACKER },
        sample: { tracker: CLI_TRACKER, publishes: true },
      },
    });
    await t.send('services.set', { project: 'example', tracker: MCP_TRACKER });

    expect(await read('example')).toMatchObject({
      tracker: MCP_TRACKER,
      trackerFrom: 'project',
      publishes: false,
      publishesFrom: 'default',
    });
    expect(await read('sample')).toMatchObject({
      tracker: CLI_TRACKER,
      trackerFrom: 'rules',
      publishes: true,
      publishesFrom: 'rules',
    });
  });

  it('changes only the field it is given and clears with null', async () => {
    await t.send('services.set', {
      project: 'example',
      tracker: MCP_TRACKER,
      publishes: true,
    });
    await t.send('services.set', { project: 'example', publishes: null });

    expect(await read('example')).toMatchObject({
      tracker: MCP_TRACKER,
      publishesFrom: 'default',
    });
  });

  it('refuses a tracker that does not say how to reach it', async () => {
    const res = await t.send('services.set', {
      project: 'example',
      tracker: { kind: 'tracker-cli', how: 'cli' },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("how: 'cli' needs a command");
  });

  it('refuses an update that changes nothing', async () => {
    const res = await t.send('services.set', { project: 'example' });

    expect(res.status).toBe(400);
  });

  it('answers 409 naming a repo services layer', async () => {
    const path = join(exampleRepo, '.quarterdeck', 'rules.local.services.json');
    await mkdir(join(exampleRepo, '.quarterdeck'), { recursive: true });
    await writeFile(path, JSON.stringify({ projects: {} }));
    try {
      const res = await t.send('services.read', { project: 'example' });

      expect(res.status).toBe(409);
      expect(res.body['error']).toContain(
        `${path}: the repo layer may not set services`,
      );
    } finally {
      await rm(path, { force: true });
    }
  });
});
