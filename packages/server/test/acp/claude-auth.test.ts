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
import {
  CANCELLED_PERMISSION,
  CLAUDE_AUTH_ERROR,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_PASS_ENV,
  ClaudeAuthError,
  childEnv,
  claudeAuthEnv,
  claudeAuthStatus,
  createClaudeAdapter,
  readClaudeAuthSetting,
  type AgentCommand,
  type KeychainRead,
  type LaunchOptions,
} from '@quarterdeck/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const ENV_KEY = 'sk-ant-api03-fromtheenvironment-0000000000';
const KEYCHAIN_KEY = 'sk-ant-api03-fromthekeychain-1111111111';

const OPTIONS: LaunchOptions = {
  clientName: 'quarterdeck-test',
  clientVersion: '0.0.0',
  spawnRetries: 0,
  onPermissionRequest: async () => CANCELLED_PERMISSION,
};

const PLATFORM_ENV = /^__CF_/;

const withoutPlatformEnv = (
  env: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !PLATFORM_ENV.test(name)),
  );

interface Keychain {
  read: KeychainRead;
  asked: string[];
}

const keychain = (key: string | undefined): Keychain => {
  const asked: string[] = [];
  return {
    asked,
    read: async (service) => {
      asked.push(service);
      return key;
    },
  };
};

describe('claude auth setting', () => {
  let home = '';

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'qd-claude-auth-')));
  });

  afterAll(() => rm(home, { recursive: true, force: true }));

  const writeSetting = async (dir: string, content: string) => {
    await mkdir(join(dir, '.quarterdeck'), { recursive: true });
    await writeFile(join(dir, '.quarterdeck', 'claude.json'), content);
  };

  it('defaults to subscription with no env and no file', async () => {
    expect(
      await readClaudeAuthSetting({ env: {}, homeDir: join(home, 'none') }),
    ).toEqual({ mode: 'subscription', source: 'default' });
  });

  it('reads ~/.quarterdeck/claude.json and lets QUARTERDECK_CLAUDE_AUTH win over it', async () => {
    const dir = join(home, 'file');
    await writeSetting(dir, JSON.stringify({ auth: 'vertex' }));
    expect(await readClaudeAuthSetting({ env: {}, homeDir: dir })).toEqual({
      mode: 'vertex',
      source: 'file',
    });
    expect(
      await readClaudeAuthSetting({
        env: { QUARTERDECK_CLAUDE_AUTH: 'api_key' },
        homeDir: dir,
      }),
    ).toEqual({ mode: 'api_key', source: 'env' });
  });

  it('refuses a mode it does not know, from env or file', async () => {
    await expect(
      readClaudeAuthSetting({ env: { QUARTERDECK_CLAUDE_AUTH: 'max' } }),
    ).rejects.toMatchObject({
      code: CLAUDE_AUTH_ERROR,
      message:
        'QUARTERDECK_CLAUDE_AUTH is "max"; set it to one of subscription, api_key, vertex',
    });
    const dir = join(home, 'bad-file');
    await writeSetting(dir, JSON.stringify({ auth: 'oauth' }));
    await expect(
      readClaudeAuthSetting({ env: {}, homeDir: dir }),
    ).rejects.toBeInstanceOf(ClaudeAuthError);
  });

  it('redacts a key pasted where the mode belongs', async () => {
    const dir = join(home, 'pasted');
    await writeSetting(dir, ENV_KEY);
    const fromEnv = readClaudeAuthSetting({
      env: { QUARTERDECK_CLAUDE_AUTH: ENV_KEY },
    });
    const fromFile = readClaudeAuthSetting({ env: {}, homeDir: dir });
    for (const refused of [fromEnv, fromFile]) {
      const err = await refused.then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err?.message).not.toContain('sk-ant-');
      expect(err?.message).toContain('[redacted]');
    }
  });
});

describe('claude auth env', () => {
  it('subscription injects nothing and never reads the Keychain', async () => {
    const chain = keychain(KEYCHAIN_KEY);
    expect(
      await claudeAuthEnv({
        env: { QUARTERDECK_CLAUDE_AUTH: 'subscription' },
        readKeychain: chain.read,
      }),
    ).toEqual({});
    expect(chain.asked).toEqual([]);
  });

  it('api_key sets ANTHROPIC_API_KEY from the env first, the Keychain second', async () => {
    const chain = keychain(KEYCHAIN_KEY);
    const env = { QUARTERDECK_CLAUDE_AUTH: 'api_key' };
    expect(
      await claudeAuthEnv({
        env: { ...env, ANTHROPIC_API_KEY: ENV_KEY },
        readKeychain: chain.read,
      }),
    ).toEqual({ set: { ANTHROPIC_API_KEY: ENV_KEY } });
    expect(chain.asked).toEqual([]);
    expect(await claudeAuthEnv({ env, readKeychain: chain.read })).toEqual({
      set: { ANTHROPIC_API_KEY: KEYCHAIN_KEY },
    });
    expect(chain.asked).toEqual([CLAUDE_KEYCHAIN_SERVICE]);
  });

  it('api_key fails clearly when neither has a key', async () => {
    await expect(
      claudeAuthEnv({
        env: { QUARTERDECK_CLAUDE_AUTH: 'api_key' },
        readKeychain: keychain(undefined).read,
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_AUTH_ERROR,
      mode: 'api_key',
      missing: ['ANTHROPIC_API_KEY'],
      message: `Claude auth mode api_key needs ANTHROPIC_API_KEY, which is not set. Export ANTHROPIC_API_KEY before starting Quarterdeck, or on macOS store it in the Keychain: security add-generic-password -a "$USER" -s ${CLAUDE_KEYCHAIN_SERVICE} -w.`,
    });
  });

  it('vertex passes its variables by name and turns Vertex on', async () => {
    expect(
      await claudeAuthEnv({
        env: {
          QUARTERDECK_CLAUDE_AUTH: 'vertex',
          ANTHROPIC_VERTEX_PROJECT_ID: 'example-project',
          CLOUD_ML_REGION: 'us-east5',
        },
      }),
    ).toEqual({
      pass: [
        'ANTHROPIC_VERTEX_PROJECT_ID',
        'CLOUD_ML_REGION',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'CLOUDSDK_CONFIG',
        'ANTHROPIC_VERTEX_BASE_URL',
      ],
      set: { CLAUDE_CODE_USE_VERTEX: '1' },
    });
  });

  it.each([
    [{}, ['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION']],
    [{ ANTHROPIC_VERTEX_PROJECT_ID: 'example-project' }, ['CLOUD_ML_REGION']],
    [{ CLOUD_ML_REGION: 'us-east5' }, ['ANTHROPIC_VERTEX_PROJECT_ID']],
  ])('vertex fails clearly with %o', async (env, missing) => {
    await expect(
      claudeAuthEnv({ env: { QUARTERDECK_CLAUDE_AUTH: 'vertex', ...env } }),
    ).rejects.toMatchObject({
      code: CLAUDE_AUTH_ERROR,
      mode: 'vertex',
      missing,
      message: expect.stringContaining(
        `Claude auth mode vertex needs ${missing.join(' and ')}, which is not set.`,
      ),
    });
  });

  it('reports the mode without the key', async () => {
    const status = await claudeAuthStatus({
      env: {
        QUARTERDECK_CLAUDE_AUTH: 'api_key',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      },
      readKeychain: keychain(KEYCHAIN_KEY).read,
    });
    expect(status).toEqual({
      mode: 'api_key',
      source: 'env',
      missing: [],
      keySource: 'keychain',
      gateway: true,
    });
    expect(JSON.stringify(status)).not.toContain('sk-ant-');
  });
});

describe('claude adapter spawns with the auth env', () => {
  let root = '';
  let configDir = '';
  const secret = randomBytes(16).toString('hex');

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qd-claude-spawn-')));
    configDir = join(root, 'claude-config');
    await mkdir(configDir);
    await mkdir(join(root, 'worktree'));
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  const serverEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin',
    HOME: '/home/example',
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    ANTHROPIC_VERTEX_PROJECT_ID: 'example-project',
    CLOUD_ML_REGION: 'us-east5',
    GOOGLE_APPLICATION_CREDENTIALS: '/home/example/adc.json',
    CLAUDE_CODE_USE_VERTEX: '0',
    GH_TOKEN: `gh-${secret}`,
    ...extra,
  });

  const spawnEnv = async (
    source: NodeJS.ProcessEnv,
    chain: Keychain = keychain(undefined),
  ): Promise<Record<string, string>> => {
    const marker = join(root, `${randomBytes(4).toString('hex')}.json`);
    const adapter = createClaudeAdapter({
      processDir: join(root, 'claude'),
      auth: { readKeychain: chain.read },
    });
    const client = await adapter.connect(
      {
        cwd: join(root, 'worktree'),
        env: { source, set: { QUARTERDECK_ENV_MARKER: marker } },
        command: envAgent(),
      },
      OPTIONS,
    );
    await client.close();
    const env = JSON.parse(await readFile(marker, 'utf8')) as Record<
      string,
      string
    >;
    return withoutPlatformEnv(env);
  };

  const base = () => ({
    PATH: '/usr/bin',
    HOME: '/home/example',
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: 'https://gateway.example.com',
  });

  it('subscription: exactly the env the adapter gave before auth modes', async () => {
    const source = serverEnv({ QUARTERDECK_CLAUDE_AUTH: 'subscription' });
    const env = await spawnEnv(source);
    const { QUARTERDECK_ENV_MARKER: marker, ...rest } = env;
    expect(rest).toEqual(base());
    expect(
      withoutPlatformEnv(
        childEnv({
          source,
          pass: CLAUDE_PASS_ENV,
          set: { QUARTERDECK_ENV_MARKER: marker ?? '' },
        }),
      ),
    ).toEqual(env);
  });

  it('subscription is the default when nothing names a mode', async () => {
    const { QUARTERDECK_ENV_MARKER: _marker, ...env } = await spawnEnv(
      serverEnv({}),
    );
    expect(env).toEqual(base());
  });

  it('api_key: adds ANTHROPIC_API_KEY from the Keychain and nothing else', async () => {
    const chain = keychain(KEYCHAIN_KEY);
    const { QUARTERDECK_ENV_MARKER: _marker, ...env } = await spawnEnv(
      serverEnv({ QUARTERDECK_CLAUDE_AUTH: 'api_key' }),
      chain,
    );
    expect(env).toEqual({ ...base(), ANTHROPIC_API_KEY: KEYCHAIN_KEY });
    expect(chain.asked).toEqual([CLAUDE_KEYCHAIN_SERVICE]);
  });

  it('api_key: an env key wins over the Keychain', async () => {
    const { QUARTERDECK_ENV_MARKER: _marker, ...env } = await spawnEnv(
      serverEnv({
        QUARTERDECK_CLAUDE_AUTH: 'api_key',
        ANTHROPIC_API_KEY: ENV_KEY,
      }),
      keychain(KEYCHAIN_KEY),
    );
    expect(env).toEqual({ ...base(), ANTHROPIC_API_KEY: ENV_KEY });
  });

  it('vertex: adds the Vertex variables by name and CLAUDE_CODE_USE_VERTEX=1', async () => {
    const { QUARTERDECK_ENV_MARKER: _marker, ...env } = await spawnEnv(
      serverEnv({ QUARTERDECK_CLAUDE_AUTH: 'vertex' }),
    );
    expect(env).toEqual({
      ...base(),
      ANTHROPIC_VERTEX_PROJECT_ID: 'example-project',
      CLOUD_ML_REGION: 'us-east5',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/example/adc.json',
      CLAUDE_CODE_USE_VERTEX: '1',
    });
  });

  it('vertex: leaves GOOGLE_APPLICATION_CREDENTIALS out when it is not set', async () => {
    const source = serverEnv({ QUARTERDECK_CLAUDE_AUTH: 'vertex' });
    delete source['GOOGLE_APPLICATION_CREDENTIALS'];
    const env = await spawnEnv(source);
    expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBe('1');
  });

  it('reads the mode from the machine file under the launch home', async () => {
    const homeDir = join(root, 'machine');
    await mkdir(join(homeDir, '.quarterdeck'), { recursive: true });
    await writeFile(
      join(homeDir, '.quarterdeck', 'claude.json'),
      JSON.stringify({ auth: 'api_key' }),
    );
    const marker = join(root, 'machine.json');
    const adapter = createClaudeAdapter({
      processDir: join(root, 'claude'),
      auth: { readKeychain: keychain(KEYCHAIN_KEY).read },
    });
    const client = await adapter.connect(
      {
        cwd: join(root, 'worktree'),
        env: { source: serverEnv({}), set: { QUARTERDECK_ENV_MARKER: marker } },
        rules: { homeDir },
        command: envAgent(),
      },
      OPTIONS,
    );
    await client.close();
    const env = JSON.parse(await readFile(marker, 'utf8')) as Record<
      string,
      string
    >;
    expect(env['ANTHROPIC_API_KEY']).toBe(KEYCHAIN_KEY);
  });

  it.each([
    [{ QUARTERDECK_CLAUDE_AUTH: 'api_key' }, ['ANTHROPIC_API_KEY']],
    [
      { QUARTERDECK_CLAUDE_AUTH: 'vertex', CLOUD_ML_REGION: '' },
      ['CLOUD_ML_REGION'],
    ],
  ])(
    'fails the spawn before starting anything with %o',
    async (extra, missing) => {
      const marker = join(
        root,
        `refused-${randomBytes(4).toString('hex')}.json`,
      );
      const adapter = createClaudeAdapter({
        processDir: join(root, 'claude'),
        auth: { readKeychain: keychain(undefined).read },
      });
      await expect(
        adapter.connect(
          {
            cwd: join(root, 'worktree'),
            env: {
              source: serverEnv(extra),
              set: { QUARTERDECK_ENV_MARKER: marker },
            },
            command: envAgent(),
          },
          OPTIONS,
        ),
      ).rejects.toMatchObject({ code: CLAUDE_AUTH_ERROR, missing });
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
});
