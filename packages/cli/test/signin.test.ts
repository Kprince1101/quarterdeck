import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QUARTERDECK_COMMAND, runSignIn } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, signInToolOf, type SignInRunner } from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const IS_WINDOWS = process.platform === 'win32';
const TIMEOUT = 60_000;

const kiro = (marker: string) => `case "$1" in
  --version) echo "kiro-cli 1.20.1" ;;
  whoami) if [ -f "${marker}" ]; then echo "me@example.com"; else echo "Not logged in" >&2; exit 1; fi ;;
  *) exit 64 ;;
esac`;

const CLAUDE_NPX = `case "$*" in
  *"--cli --version") echo "2.1.30 (Claude Code)" ;;
  *"--cli auth status --json") echo '{"loggedIn":true,"email":"me@example.com"}' ;;
  *) exit 64 ;;
esac`;

const GEMINI = `case "$1" in
  --version) echo "0.9.0" ;;
  *) exit 64 ;;
esac`;

const gh = (marker: string, loginExit = 0) => `case "$*" in
  --version) echo "gh version 2.81.0 (2025-09-01)" ;;
  "auth status")
    if [ -f "${marker}" ]; then echo "  ✓ Logged in to github.com account me (keyring)"; exit 0; fi
    echo "You are not logged into any GitHub hosts."; exit 1 ;;
  "auth login --web --git-protocol https")
    echo "! First copy your one-time code: ABCD-1234" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    if [ ${loginExit} -ne 0 ]; then echo "error: device flow was denied" >&2; exit ${loginExit}; fi
    touch "${marker}" ;;
  *) exit 64 ;;
esac`;

describe('signInToolOf', () => {
  it.each([
    ['kiro-cli', { kind: 'runtime', runtime: 'kiro' }],
    ['claude', { kind: 'runtime', runtime: 'claude' }],
    ['gemini', { kind: 'runtime', runtime: 'gemini' }],
    ['gh', { kind: 'gh' }],
    [
      'glab on gitlab.example.com',
      { kind: 'glab', host: 'gitlab.example.com' },
    ],
  ])('turns a signed-out %s into its sign-in', (name, tool) => {
    expect(signInToolOf({ name, fixes: [{ label: 'Sign in' }] })).toEqual(tool);
  });

  it('leaves a tool that is not installed, and other misses, alone', () => {
    expect(
      signInToolOf({
        name: 'gh',
        fixes: [{ label: 'Install' }, { label: 'Sign in' }],
      }),
    ).toBeUndefined();
    expect(
      signInToolOf({ name: 'gh for agents', fixes: [{ label: 'Sign in' }] }),
    ).toBeUndefined();
    expect(signInToolOf({ name: 'gh', fixes: [] })).toBeUndefined();
  });
});

describe.skipIf(IS_WINDOWS)('quarterdeck doctor signing in', () => {
  let box: Sandbox;
  let bin = '';
  let io: TestIo;
  let kiroMarker = '';
  let ghMarker = '';

  const fake = async (name: string, script: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
  };

  const doctor = (signIn: SignInRunner) =>
    main(['doctor'], {
      ...io,
      env: { PATH: `${bin}:/usr/bin:/bin`, GEMINI_API_KEY: 'set' },
      signIn,
    });

  beforeEach(async () => {
    box = await sandbox();
    bin = join(box.home, 'bin');
    await mkdir(bin);
    io = testIo(box.home);
    kiroMarker = join(box.home, 'kiro-signed-in');
    ghMarker = join(box.home, 'gh-signed-in');
    await fake('kiro-cli', kiro(kiroMarker));
    await fake('npx', CLAUDE_NPX);
    await fake('gemini', GEMINI);
    await fake('gh', gh(ghMarker));
    await writeFile(ghMarker, '');
  });

  afterEach(async () => {
    await box.close();
  });

  it(
    'runs the sign-in for a signed-out runtime, checks again and finishes green',
    async () => {
      const signIn = vi.fn<SignInRunner>(async () => {
        await writeFile(kiroMarker, '');
        return { ok: true, via: 'ACP authenticate kiro-login' };
      });

      expect(await doctor(signIn)).toBe(0);
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(signIn.mock.calls[0]?.[0]).toEqual({
        kind: 'runtime',
        runtime: 'kiro',
      });
      expect(io.lines).toContain(
        'kiro-cli: 1.20.1, signed in (me@example.com)',
      );
      expect(io.lines.at(-1)).toBe('All set.');
    },
    TIMEOUT,
  );

  it(
    'signs gh in through its web login, shows the code and opens the URL',
    async () => {
      await writeFile(kiroMarker, '');
      await rm(ghMarker);
      const opened: string[] = [];
      const signIn: SignInRunner = (tool, run) =>
        runSignIn(tool, {
          env: run.env,
          tty: false,
          onProgress: (progress) => {
            if (progress.code) run.out(`code ${progress.code}`);
          },
          openUrl: (url) => {
            opened.push(url);
            return Promise.resolve();
          },
        });

      expect(await doctor(signIn)).toBe(0);
      expect(opened).toEqual(['https://github.com/login/device']);
      expect(io.lines).toContain('code ABCD-1234');
      expect(io.lines).toContain('gh: 2.81.0, signed in (me on github.com)');
      expect(io.lines.at(-1)).toBe('All set.');
    },
    TIMEOUT,
  );

  it(
    'signs the chosen runtime in during init, then init carries on',
    async () => {
      const signIn = vi.fn<SignInRunner>(async () => {
        await writeFile(kiroMarker, '');
        return { ok: true, via: 'ACP authenticate kiro-login' };
      });
      await rm(ghMarker);

      const code = await main(
        ['init', box.repo, '--runtime', 'kiro', '--no-folder'],
        {
          ...io,
          env: { PATH: `${bin}:/usr/bin:/bin` },
          signIn,
        },
      );

      expect(code).toBe(0);
      expect(signIn.mock.calls.map(([tool]) => tool)).toEqual([
        { kind: 'runtime', runtime: 'kiro' },
      ]);
      expect(io.lines.at(-1)).toBe(`Next: ${QUARTERDECK_COMMAND} up`);
    },
    TIMEOUT,
  );

  it(
    'falls back to the command, and says why, when the sign-in fails',
    async () => {
      await writeFile(kiroMarker, '');
      await fake('gh', gh(ghMarker, 1));
      await rm(ghMarker);
      const signIn: SignInRunner = (tool, run) =>
        runSignIn(tool, {
          env: run.env,
          tty: false,
          openUrl: () => Promise.resolve(),
        });

      expect(await doctor(signIn)).toBe(1);
      const at = io.lines.indexOf('gh: 2.81.0, not signed in');
      expect(io.lines.slice(at, at + 3)).toEqual([
        'gh: 2.81.0, not signed in',
        '  Sign in: gh auth login',
        '  Why: automatic sign-in failed: gh auth login --web exited with 1: error: device flow was denied',
      ]);
    },
    TIMEOUT,
  );
});
