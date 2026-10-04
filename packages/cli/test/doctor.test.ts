import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCTOR_FIXES,
  main,
  runDoctorChecks,
  type DoctorCheck,
} from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const IS_WINDOWS = process.platform === 'win32';
const PINNED = '@agentclientprotocol/claude-agent-acp@0.85.0';

const KIRO_SIGNED_OUT = `case "$1" in
  --version) echo "kiro-cli 1.20.1" ;;
  whoami) echo "Not logged in" >&2; exit 1 ;;
  *) exit 64 ;;
esac`;

const claudeNpx = (log: string, status: string, statusExit = 0) => `
echo "$npm_config_registry $*" >> "${log}"
case "$*" in
  *"--cli --version") echo "2.1.30 (Claude Code)" ;;
  *"--cli auth status --json") echo '${status}'; exit ${statusExit} ;;
  *) exit 64 ;;
esac`;

const GEMINI = `case "$1" in
  --version) echo "0.9.0" ;;
  *) exit 64 ;;
esac`;

const ghFake = (status: string, statusExit = 0) => `case "$*" in
  --version) echo "gh version 2.81.0 (2025-09-01)" ;;
  "auth status") echo "${status}"; exit ${statusExit} ;;
  *) exit 64 ;;
esac`;

const GH_SIGNED_IN =
  '  ✓ Logged in to github.com account example-org (keyring)';

const GH_TOKEN_ONLY = `case "$*" in
  --version) echo "gh version 2.81.0 (2025-09-01)" ;;
  "auth status")
    if [ -z "$GH_TOKEN" ]; then echo "You are not logged into any GitHub hosts."; exit 1; fi
    echo "  ✓ Logged in to github.com account example (GH_TOKEN)" ;;
  *) exit 64 ;;
esac`;

describe.skipIf(IS_WINDOWS)('quarterdeck doctor', () => {
  let box: Sandbox;
  let bin = '';
  let io: TestIo;

  const fake = async (name: string, script: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
  };

  const check = (checks: DoctorCheck[], name: string) =>
    checks.find((found) => found.name === name);

  const doctor = async (env: NodeJS.ProcessEnv = {}) =>
    runDoctorChecks(
      { ...io, env: { PATH: bin, ...env } },
      { platform: 'linux' },
    );

  beforeEach(async () => {
    box = await sandbox();
    bin = join(box.home, 'bin');
    await mkdir(bin);
    io = testIo(box.home);
  });

  afterEach(async () => {
    await box.close();
  });

  it('names the install and sign-in command for each tool that is missing', async () => {
    expect(await doctor()).toEqual([
      {
        name: 'kiro-cli',
        state: 'not installed',
        fixes: [
          { label: 'Install', command: DOCTOR_FIXES.kiroInstall },
          { label: 'Sign in', command: 'kiro-cli login' },
        ],
      },
      {
        name: 'claude',
        state: 'npx not found',
        fixes: [
          { label: 'Install', command: DOCTOR_FIXES.node },
          {
            label: 'Sign in',
            command: `npx --yes ${PINNED} --cli auth login --claudeai`,
          },
        ],
      },
      {
        name: 'gemini',
        state: 'not installed',
        fixes: [
          { label: 'Install', command: 'npm install -g @google/gemini-cli' },
          { label: 'Sign in', command: DOCTOR_FIXES.geminiSignIn },
        ],
      },
      {
        name: 'gh',
        state: 'not installed',
        fixes: [
          {
            label: 'Install',
            command:
              'see https://github.com/cli/cli#installation for your system',
          },
          { label: 'Sign in', command: 'gh auth login' },
        ],
      },
    ]);
  });

  it('gives the platform install command for gh', async () => {
    const darwin = await runDoctorChecks(
      { ...io, env: { PATH: bin } },
      { platform: 'darwin' },
    );
    expect(check(darwin, 'gh')?.fixes[0]).toEqual({
      label: 'Install',
      command: 'brew install gh',
    });
  });

  describe('kiro-cli', () => {
    it('tells a signed-out kiro-cli to run kiro-cli login', async () => {
      await fake('kiro-cli', KIRO_SIGNED_OUT);
      expect(check(await doctor(), 'kiro-cli')).toEqual({
        name: 'kiro-cli',
        state: '1.20.1, not signed in',
        fixes: [{ label: 'Sign in', command: 'kiro-cli login' }],
      });
    });

    it('says when kiro-cli --version fails', async () => {
      await fake('kiro-cli', 'exit 2');
      expect(check(await doctor(), 'kiro-cli')).toEqual({
        name: 'kiro-cli',
        state: 'kiro-cli --version failed (exited with 2)',
        fixes: [
          { label: 'Install', command: DOCTOR_FIXES.kiroInstall },
          { label: 'Sign in', command: 'kiro-cli login' },
        ],
      });
    });
  });

  describe('claude', () => {
    let log = '';

    beforeEach(() => {
      log = join(box.home, 'npx.log');
    });

    it('asks the pinned claude-agent-acp, offline and from the public registry', async () => {
      await fake(
        'npx',
        claudeNpx(log, '{"loggedIn":true,"email":"user@example.com"}'),
      );
      expect(check(await doctor(), 'claude')).toEqual({
        name: 'claude',
        state: '2.1.30, signed in (user@example.com)',
        fixes: [],
      });
      const calls = (await readFile(log, 'utf8')).trim().split('\n').toSorted();
      expect(calls).toEqual([
        `https://registry.npmjs.org/ --yes --offline ${PINNED} --cli --version`,
        `https://registry.npmjs.org/ --yes --offline ${PINNED} --cli auth status --json`,
      ]);
    });

    it('prints the npx sign-in command when Claude Code is signed out', async () => {
      await fake('npx', claudeNpx(log, '{"loggedIn":false}', 1));
      expect(check(await doctor(), 'claude')).toEqual({
        name: 'claude',
        state: '2.1.30, not signed in',
        fixes: [
          {
            label: 'Sign in',
            command: `npx --yes ${PINNED} --cli auth login --claudeai`,
          },
        ],
      });
    });

    it('counts an API key as signed in', async () => {
      await fake(
        'npx',
        claudeNpx(log, '{"loggedIn":false,"apiKeySource":"ANTHROPIC_API_KEY"}'),
      );
      expect(check(await doctor(), 'claude')?.state).toBe(
        '2.1.30, signed in (API key from ANTHROPIC_API_KEY)',
      );
    });

    it('says how to download claude-agent-acp when npx has not fetched it', async () => {
      await fake('npx', 'echo "npm error code ENOTCACHED" >&2\nexit 1');
      expect(check(await doctor(), 'claude')).toEqual({
        name: 'claude',
        state: `${PINNED} is not downloaded yet`,
        fixes: [
          {
            label: 'Download',
            command: `npx --yes ${PINNED} --cli --version`,
          },
          {
            label: 'Sign in',
            command: `npx --yes ${PINNED} --cli auth login --claudeai`,
          },
        ],
      });
    });
  });

  describe('gemini', () => {
    beforeEach(async () => {
      await fake('gemini', GEMINI);
    });

    it('is not signed in without credentials', async () => {
      expect(check(await doctor(), 'gemini')).toEqual({
        name: 'gemini',
        state: '0.9.0, not signed in',
        fixes: [{ label: 'Sign in', command: DOCTOR_FIXES.geminiSignIn }],
      });
    });

    it('finds a Google sign-in in ~/.gemini', async () => {
      await mkdir(join(box.home, '.gemini'));
      await writeFile(join(box.home, '.gemini', 'oauth_creds.json'), '{}');
      expect(check(await doctor(), 'gemini')?.state).toBe(
        '0.9.0, signed in (Google account)',
      );
    });

    it.each([
      [{ GEMINI_API_KEY: 'key' }, 'GEMINI_API_KEY'],
      [{ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_API_KEY: 'k' }, 'Vertex AI'],
    ])('accepts %o', async (env, source) => {
      expect(check(await doctor(env), 'gemini')?.state).toBe(
        `0.9.0, signed in (${source})`,
      );
    });
  });

  describe('gh', () => {
    it('reports the signed-in account', async () => {
      await fake('gh', ghFake(GH_SIGNED_IN));
      expect(check(await doctor(), 'gh')).toEqual({
        name: 'gh',
        state: '2.81.0, signed in (example-org on github.com)',
        fixes: [],
      });
    });

    it('tells a signed-out gh to run gh auth login', async () => {
      await fake('gh', ghFake('You are not logged into any GitHub hosts.', 1));
      expect(check(await doctor(), 'gh')).toEqual({
        name: 'gh',
        state: '2.81.0, not signed in',
        fixes: [{ label: 'Sign in', command: 'gh auth login' }],
      });
    });

    it('says when gh works only through GH_TOKEN, which agents do not get', async () => {
      await fake('gh', GH_TOKEN_ONLY);
      const checks = await doctor({ GH_TOKEN: 'gh-example' });
      expect(check(checks, 'gh')?.fixes).toEqual([]);
      expect(check(checks, 'gh for agents')).toEqual({
        name: 'gh for agents',
        state:
          'signed in only through GH_TOKEN, which agents do not get; unset GH_TOKEN and sign in',
        fixes: [{ label: 'Sign in', command: 'gh auth login' }],
      });
    });

    it('has nothing to say when gh is signed in without the token too', async () => {
      await fake('gh', ghFake(GH_SIGNED_IN));
      const checks = await doctor({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' });
      expect(check(checks, 'gh for agents')).toBeUndefined();
    });

    it('gives up on a hung gh', async () => {
      await fake('gh', 'exec /bin/sleep 5');
      const checks = await runDoctorChecks(
        { ...io, env: { PATH: bin } },
        { platform: 'linux', timeoutMs: 200 },
      );
      expect(check(checks, 'gh')?.state).toBe(
        'gh --version failed (timed out)',
      );
    });
  });

  describe('glab', () => {
    const GLAB = `case "$*" in
  --version) echo "glab 1.46.1 (2024-09-26)" ;;
  "auth status --hostname git.example.org")
    echo "  ✓ Logged in to git.example.org as example-user (/home/u/.config/glab-cli/config.yml)" >&2 ;;
  "auth status --hostname "*) echo "  x No token found" >&2; exit 1 ;;
  *) exit 64 ;;
esac`;

    const mapGitlab = async (hosts: string[]) => {
      await mkdir(join(box.home, '.quarterdeck'));
      await writeFile(
        join(box.home, '.quarterdeck', 'rules.local.forges.json'),
        JSON.stringify({
          forges: Object.fromEntries(hosts.map((host) => [host, 'gitlab'])),
        }),
      );
    };

    const glabChecks = (checks: DoctorCheck[]) =>
      checks.filter((found) => found.name.startsWith('glab'));

    it('says nothing about glab when no GitLab host is in use', async () => {
      expect(glabChecks(await doctor())).toEqual([]);
    });

    it('names the install and a sign-in per host when glab is missing', async () => {
      await mapGitlab(['git.example.org', 'Code.Example.com']);

      expect(glabChecks(await doctor())).toEqual([
        {
          name: 'glab',
          state: 'not installed, needed for code.example.com, git.example.org',
          fixes: [
            {
              label: 'Install',
              command:
                'see https://gitlab.com/gitlab-org/cli#installation for your system',
            },
            {
              label: 'Sign in',
              command: 'glab auth login --hostname code.example.com',
            },
            {
              label: 'Sign in',
              command: 'glab auth login --hostname git.example.org',
            },
          ],
        },
      ]);
    });

    it('checks the sign-in on each mapped host', async () => {
      await mapGitlab(['git.example.org', 'code.example.com']);
      await fake('glab', GLAB);

      expect(glabChecks(await doctor())).toEqual([
        {
          name: 'glab on code.example.com',
          state: '1.46.1, not signed in',
          fixes: [
            {
              label: 'Sign in',
              command: 'glab auth login --hostname code.example.com',
            },
          ],
        },
        {
          name: 'glab on git.example.org',
          state: '1.46.1, signed in (example-user on git.example.org)',
          fixes: [],
        },
      ]);
    });

    it('checks the origin host of this folder when it is on GitLab', async () => {
      await fake('glab', GLAB);
      await fake(
        'git',
        `case "$*" in
  *"remote get-url origin") echo "git@gitlab.com:example-group/deck.git" ;;
  *) exit 64 ;;
esac`,
      );

      expect(glabChecks(await doctor())).toEqual([
        {
          name: 'glab on gitlab.com',
          state: '1.46.1, not signed in',
          fixes: [
            {
              label: 'Sign in',
              command: 'glab auth login --hostname gitlab.com',
            },
          ],
        },
      ]);
    });

    it('leaves out an origin on GitHub', async () => {
      await fake('git', 'echo "git@github.com:example-org/quarterdeck.git"');

      expect(glabChecks(await doctor())).toEqual([]);
    });

    it('gives the platform install command for glab', async () => {
      await mapGitlab(['git.example.org']);
      const darwin = await runDoctorChecks(
        { ...io, env: { PATH: bin } },
        { platform: 'darwin' },
      );

      expect(check(darwin, 'glab')?.fixes[0]).toEqual({
        label: 'Install',
        command: 'brew install glab',
      });
    });
  });

  it('prints each check with its commands and exits 1 while any needs attention', async () => {
    await fake('kiro-cli', KIRO_SIGNED_OUT);
    await fake(
      'npx',
      claudeNpx(join(box.home, 'npx.log'), '{"loggedIn":true}'),
    );
    await fake('gemini', GEMINI);
    await fake('gh', ghFake(GH_SIGNED_IN));
    const run = { ...io, env: { PATH: bin, GEMINI_API_KEY: 'key' } };

    expect(await main(['doctor'], run)).toBe(1);
    expect(io.lines).toEqual([
      'kiro-cli: 1.20.1, not signed in',
      '  Sign in: kiro-cli login',
      'claude: 2.1.30, signed in (claude.ai)',
      'gemini: 0.9.0, signed in (GEMINI_API_KEY)',
      'gh: 2.81.0, signed in (example-org on github.com)',
      '',
      '1 of 4 need attention. Run the commands above, then npm run quarterdeck -- doctor again.',
    ]);
    expect(io.errors).toEqual([]);
  });

  it('refuses arguments', async () => {
    expect(await main(['doctor', 'kiro'], io)).toBe(1);
    expect(io.errors).toEqual(['doctor takes no arguments']);
  });
});
