import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRule } from '@quarterdeck/rules';
import {
  CANCELLED_PERMISSION,
  childEnv,
  createClaudeAdapter,
  createGeminiAdapter,
  createKiroAdapter,
  defineRuntimeAdapter,
  launchSite,
  runCommand,
  withChildEnv,
} from '@quarterdeck/server';
import type {
  AgentCommand,
  LaunchOptions,
  RuntimeAdapter,
  RuntimeLaunch,
} from '@quarterdeck/server';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { fakeAgentLaunch } from './fake-agent/index.ts';

const ENV_AGENT = fileURLToPath(
  new URL('env-fixtures/env-agent.ts', import.meta.url),
);

const envAgent = (): AgentCommand => {
  const fake = fakeAgentLaunch();
  return {
    command: fake.command,
    args: fake.args.map((arg) => {
      if (arg.endsWith('main.ts')) return ENV_AGENT;
      return arg;
    }),
  };
};

const SECRETS = ['DATABASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN', 'SECRET_X'];

describe('childEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/example',
    USER: 'example',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    LC_CTYPE: 'UTF-8',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    QUARTERDECK_BUS_SOCKET: '/tmp/bus.sock',
    QUARTERDECK_BUS_TOKEN: 'bus-token',
    QUARTERDECK_HOME: '/home/example/.quarterdeck',
    DATABASE_URL: 'postgres://example:secret@localhost/example',
    GH_TOKEN: 'gh-secret',
    GITHUB_TOKEN: 'github-secret',
    EXAMPLE_TOKEN: 'example-token',
  };

  it('keeps the allowlist, LC_* and the bus variables and drops the rest', () => {
    expect(childEnv({ source })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/example',
      USER: 'example',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      QUARTERDECK_BUS_SOCKET: '/tmp/bus.sock',
      QUARTERDECK_BUS_TOKEN: 'bus-token',
    });
  });

  it('passes extra names with their values from the source only', () => {
    const env = childEnv({ source, pass: ['EXAMPLE_TOKEN', 'NOT_SET'] });
    expect(env['EXAMPLE_TOKEN']).toBe('example-token');
    expect(env).not.toHaveProperty('NOT_SET');
    expect(env).not.toHaveProperty('GH_TOKEN');
  });

  it('lets set values win over passed ones', () => {
    expect(
      childEnv({ source, set: { LC_ALL: 'en_US.UTF-8', EXTRA: '1' } }),
    ).toMatchObject({ LC_ALL: 'en_US.UTF-8', EXTRA: '1' });
  });

  it('reads the server env when no source is given', () => {
    vi.stubEnv('SECRET_X', 'x');
    try {
      expect(childEnv()).not.toHaveProperty('SECRET_X');
      expect(childEnv({ pass: ['SECRET_X'] })['SECRET_X']).toBe('x');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('merges specs so later sets win and names add up', () => {
    expect(
      withChildEnv(
        { pass: ['A'], set: { X: '1', Y: '1' } },
        { pass: ['B'], set: { Y: '2' } },
      ),
    ).toEqual({ pass: ['A', 'B'], set: { X: '1', Y: '2' } });
  });
});

describe('spawned agents', () => {
  let root = '';
  const secret = randomBytes(16).toString('hex');

  const options: LaunchOptions = {
    clientName: 'quarterdeck-test',
    clientVersion: '0.0.0',
    spawnRetries: 0,
    onPermissionRequest: async () => CANCELLED_PERMISSION,
  };

  const busToken = randomBytes(16).toString('hex');

  const adapterFor = (name: string): RuntimeAdapter => {
    if (name === 'kiro')
      return createKiroAdapter({
        agentsDir: join(root, 'kiro-agents'),
        processDir: join(root, 'kiro'),
      });
    if (name === 'claude')
      return createClaudeAdapter({ processDir: join(root, 'claude') });
    if (name === 'gemini')
      return createGeminiAdapter({
        dir: join(root, 'gemini'),
        systemConfigDir: join(root, 'no-system-config'),
      });
    return defineRuntimeAdapter({
      runtime: 'kiro',
      displayName: 'Generic',
      command: (launch) => ({ ...launchSite(launch), ...envAgent() }),
    });
  };

  const launchAndRead = async (
    adapter: RuntimeAdapter,
    pass: readonly string[] = [],
  ): Promise<Record<string, string>> => {
    const marker = join(
      root,
      `${adapter.runtime}-${randomBytes(4).toString('hex')}.json`,
    );
    const launch: RuntimeLaunch = {
      cwd: join(root, 'worktree'),
      project: 'example',
      agentName: 'builder-1',
      env: {
        pass,
        set: {
          QUARTERDECK_ENV_MARKER: marker,
          CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
        },
      },
      command: envAgent(),
    };
    const client = await adapter.connect(launch, options);
    await client.close();
    return JSON.parse(await readFile(marker, 'utf8')) as Record<string, string>;
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qd-env-')));
    await mkdir(join(root, 'worktree'));
    await mkdir(join(root, 'claude-config'));
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  beforeEach(() => {
    vi.stubEnv(
      'DATABASE_URL',
      `postgres://example:${secret}@localhost/example`,
    );
    vi.stubEnv('GH_TOKEN', `gh-${secret}`);
    vi.stubEnv('GITHUB_TOKEN', `github-${secret}`);
    vi.stubEnv('SECRET_X', secret);
    vi.stubEnv('QUARTERDECK_BUS_SOCKET', join(root, 'bus.sock'));
    vi.stubEnv('QUARTERDECK_BUS_TOKEN', busToken);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['generic', 'kiro', 'claude', 'gemini'])(
    '%s: the agent gets PATH, HOME and the bus variables but no server secrets',
    async (name) => {
      const env = await launchAndRead(adapterFor(name));
      for (const key of SECRETS) expect(env).not.toHaveProperty(key);
      expect(Object.values(env).some((value) => value.includes(secret))).toBe(
        false,
      );
      expect(env['PATH']).toBe(process.env['PATH']);
      expect(env['HOME']).toBe(process.env['HOME']);
      expect(env['QUARTERDECK_BUS_SOCKET']).toBe(join(root, 'bus.sock'));
      expect(env['QUARTERDECK_BUS_TOKEN']).toBe(busToken);
    },
  );

  const writeEnvRule = async (dir: string, pass: string[]) => {
    await mkdir(join(dir, '.quarterdeck'), { recursive: true });
    await writeFile(
      join(dir, '.quarterdeck', 'rules.local.env.json'),
      JSON.stringify({ pass }),
    );
  };

  it('passes a name the machine env rule adds, with its value from the server env', async () => {
    const home = join(root, 'machine-home');
    const repo = join(root, 'machine-repo');
    await writeEnvRule(home, ['EXAMPLE_TOKEN']);
    await mkdir(repo, { recursive: true });
    vi.stubEnv('EXAMPLE_TOKEN', 'example-token');

    const rule = await loadRule('env', { homeDir: home, repoDir: repo });
    expect(rule).toEqual({ pass: ['EXAMPLE_TOKEN'] });
    const env = await launchAndRead(adapterFor('generic'), rule.pass);
    expect(env['EXAMPLE_TOKEN']).toBe('example-token');
    for (const key of SECRETS) expect(env).not.toHaveProperty(key);
  });

  it('ignores an env rule in the repo layer, which agents can write', async () => {
    const home = join(root, 'repo-home');
    const repo = join(root, 'repo-layer');
    await writeEnvRule(home, ['EXAMPLE_TOKEN']);
    await writeEnvRule(repo, ['GH_TOKEN', 'DATABASE_URL', 'SECRET_X']);
    vi.stubEnv('EXAMPLE_TOKEN', 'example-token');

    const rule = await loadRule('env', { homeDir: home, repoDir: repo });
    expect(rule).toEqual({ pass: ['EXAMPLE_TOKEN'] });
    const env = await launchAndRead(adapterFor('generic'), rule.pass);
    expect(env['EXAMPLE_TOKEN']).toBe('example-token');
    for (const key of SECRETS) expect(env).not.toHaveProperty(key);
  });

  it('runs version probes and other commands with the same env', async () => {
    const result = await runCommand(
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      },
      { timeoutMs: 10_000 },
    );
    if (result.status !== 'exited') throw new Error(result.error);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    for (const key of SECRETS) expect(env).not.toHaveProperty(key);
    expect(env['PATH']).toBe(process.env['PATH']);
  });
});
