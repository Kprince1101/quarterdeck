import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeychainRead } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_AUTH_FIXES,
  checkClaudeAuth,
  main,
  runDoctorChecks,
  withClaudeAuthEnv,
  type DoctorCheck,
} from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const IS_WINDOWS = process.platform === 'win32';
const KEY = `sk-ant-api03-${'d'.repeat(40)}`;
const NO_KEY: KeychainRead = async () => undefined;
const SET_KEY: DoctorCheck['fixes'][number] = {
  label: 'Set',
  command: CLAUDE_AUTH_FIXES.apiKeyEnv,
};
const SET_KEYCHAIN: DoctorCheck['fixes'][number] = {
  label: 'Set',
  command: CLAUDE_AUTH_FIXES.apiKeyKeychain,
};

const KEY_FIXES: Partial<Record<NodeJS.Platform, DoctorCheck['fixes']>> = {
  darwin: [SET_KEY, SET_KEYCHAIN],
};

describe.skipIf(IS_WINDOWS)('quarterdeck doctor: claude auth', () => {
  let box: Sandbox;
  let io: TestIo;
  let bin = '';

  const fake = async (name: string, script: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
  };

  const ioWith = (env: NodeJS.ProcessEnv): TestIo => ({
    ...io,
    env: { PATH: bin, ...env },
  });

  const check = async (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = 'linux',
    readKeychain = NO_KEY,
  ) => checkClaudeAuth(ioWith(env), { platform, readKeychain });

  beforeEach(async () => {
    box = await sandbox();
    bin = join(box.home, 'bin');
    await mkdir(bin);
    io = testIo(box.home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await box.close();
  });

  it('reports subscription as the default', async () => {
    expect(await check({})).toEqual([
      {
        name: 'claude auth',
        state: 'subscription (the default), uses the Claude Code sign-in',
        fixes: [],
      },
    ]);
  });

  it('names the machine file when the mode comes from it, and a gateway', async () => {
    await mkdir(join(box.home, '.quarterdeck'));
    await writeFile(
      join(box.home, '.quarterdeck', 'claude.json'),
      JSON.stringify({ auth: 'api_key' }),
    );
    const [found] = await check({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    });
    expect(found?.state).toBe(
      `api_key (from ${join(box.home, '.quarterdeck', 'claude.json')}), ANTHROPIC_API_KEY from the environment, through ANTHROPIC_BASE_URL`,
    );
    expect(found?.fixes).toEqual([]);
    expect(JSON.stringify(found)).not.toContain('sk-ant-');
  });

  it('finds the key in the Keychain', async () => {
    expect(
      await check(
        { QUARTERDECK_CLAUDE_AUTH: 'api_key' },
        'darwin',
        async () => KEY,
      ),
    ).toEqual([
      {
        name: 'claude auth',
        state:
          'api_key (from QUARTERDECK_CLAUDE_AUTH), ANTHROPIC_API_KEY from the Keychain (quarterdeck-anthropic-api-key)',
        fixes: [],
      },
    ]);
  });

  it.each(['linux', 'darwin'] as const)(
    'says what to set when the api key is missing on %s',
    async (platform) => {
      expect(
        await check({ QUARTERDECK_CLAUDE_AUTH: 'api_key' }, platform),
      ).toEqual([
        {
          name: 'claude auth',
          state:
            'api_key (from QUARTERDECK_CLAUDE_AUTH), ANTHROPIC_API_KEY not set',
          fixes: KEY_FIXES[platform] ?? [SET_KEY],
        },
      ]);
    },
  );

  it('names each Vertex variable that is missing', async () => {
    expect(
      await check({
        QUARTERDECK_CLAUDE_AUTH: 'vertex',
        ANTHROPIC_VERTEX_PROJECT_ID: 'example-project',
      }),
    ).toEqual([
      {
        name: 'claude auth',
        state: 'vertex (from QUARTERDECK_CLAUDE_AUTH), CLOUD_ML_REGION not set',
        fixes: [
          {
            label: 'Set',
            command:
              'export CLOUD_ML_REGION=<value>, then start Quarterdeck from that shell',
          },
        ],
      },
    ]);
  });

  it('checks for application-default credentials once the Vertex env is set', async () => {
    const env = {
      QUARTERDECK_CLAUDE_AUTH: 'vertex',
      ANTHROPIC_VERTEX_PROJECT_ID: 'example-project',
      CLOUD_ML_REGION: 'us-east5',
    };
    const adc = join(
      box.home,
      '.config',
      'gcloud',
      'application_default_credentials.json',
    );
    expect(await check(env)).toEqual([
      {
        name: 'claude auth',
        state: `vertex (from QUARTERDECK_CLAUDE_AUTH), Vertex env set, but no application-default credentials at ${adc}`,
        fixes: [{ label: 'Sign in', command: CLAUDE_AUTH_FIXES.adc }],
      },
    ]);
    await mkdir(join(box.home, '.config', 'gcloud'), { recursive: true });
    await writeFile(adc, '{}');
    expect((await check(env))[0]?.fixes).toEqual([]);
    const explicit = join(box.home, 'sa.json');
    await writeFile(explicit, '{}');
    expect(
      (await check({ ...env, GOOGLE_APPLICATION_CREDENTIALS: explicit }))[0]
        ?.state,
    ).toBe(
      `vertex (from QUARTERDECK_CLAUDE_AUTH), Vertex env set, application-default credentials at ${explicit}`,
    );
  });

  it('flags a mode it does not know', async () => {
    expect(await check({ QUARTERDECK_CLAUDE_AUTH: 'max' })).toEqual([
      {
        name: 'claude auth',
        state:
          'QUARTERDECK_CLAUDE_AUTH is "max"; set it to one of subscription, api_key, vertex',
        fixes: [{ label: 'Set', command: CLAUDE_AUTH_FIXES.mode }],
      },
    ]);
  });

  it('probes claude with the key the agents will get', async () => {
    await fake(
      'npx',
      `case "$*" in
  *"--cli --version") echo "2.1.30 (Claude Code)" ;;
  *"--cli auth status --json")
    if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":false,"apiKeySource":"ANTHROPIC_API_KEY"}'; exit 0; fi
    echo '{"loggedIn":false}'; exit 1 ;;
  *) exit 64 ;;
esac`,
    );
    const run = ioWith({ QUARTERDECK_CLAUDE_AUTH: 'api_key' });
    const options = {
      platform: 'darwin' as const,
      readKeychain: async () => KEY,
    };
    const claudeOf = async (target: TestIo) =>
      (await runDoctorChecks(target, { platform: 'linux' })).find(
        ({ name }) => name === 'claude',
      );

    expect((await claudeOf(run))?.state).toBe('2.1.30, not signed in');
    const authed = await withClaudeAuthEnv(run, options);
    expect((await claudeOf({ ...run, ...authed }))?.state).toBe(
      '2.1.30, signed in (API key from ANTHROPIC_API_KEY)',
    );
    expect(await withClaudeAuthEnv(ioWith({}), options)).toEqual(ioWith({}));
  });

  it('prints the missing key and exits 1', async () => {
    await fake('security', 'exit 44');
    vi.stubEnv('PATH', bin);

    expect(
      await main(['doctor'], ioWith({ QUARTERDECK_CLAUDE_AUTH: 'api_key' })),
    ).toBe(1);
    const fixes = KEY_FIXES[process.platform] ?? [SET_KEY];
    const at = io.lines.indexOf(
      'claude auth: api_key (from QUARTERDECK_CLAUDE_AUTH), ANTHROPIC_API_KEY not set',
    );
    expect(at).toBeGreaterThan(0);
    expect(io.lines.slice(at + 1, at + 1 + fixes.length)).toEqual(
      fixes.map(({ label, command }) => `  ${label}: ${command}`),
    );
    expect(io.lines.join('\n')).not.toContain('sk-ant-');
    expect(io.lines.at(-1)).toMatch(/^\d+ of \d+ need attention\./);
  });
});
