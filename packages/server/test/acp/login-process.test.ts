import { describe, expect, it } from 'vitest';
import {
  readSignInPrompt,
  runLoginProcess,
  trackSignInPrompt,
  type LoginCommand,
  type SignInProgress,
} from '@quarterdeck/server';

const TIMEOUT = 30_000;

const GH_OUTPUT = [
  '! First copy your one-time code: ABCD-1234',
  'Open this URL to continue in your web browser: https://github.com/login/device',
];

const stub = (
  script: string,
  extra: Partial<LoginCommand> = {},
): LoginCommand => ({
  command: process.execPath,
  args: ['-e', script],
  display: 'gh auth login --web',
  opensBrowser: false,
  ...extra,
});

const printsThenExits = (lines: string[], code: number) =>
  stub(
    `${lines.map((line) => `console.error(${JSON.stringify(line)});`).join('')}process.exit(${code});`,
  );

const run = async (login: LoginCommand, timeoutMs?: number) => {
  const progress: SignInProgress[] = [];
  const opened: string[] = [];
  const outcome = await runLoginProcess(login, {
    onProgress: (step) => progress.push(step),
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  return { outcome, progress, opened };
};

describe('readSignInPrompt', () => {
  it.each([
    ['! First copy your one-time code: ABCD-1234', { code: 'ABCD-1234' }],
    [
      'Open this URL to continue in your web browser: https://github.com/login/device.',
      { url: 'https://github.com/login/device' },
    ],
    [
      "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=x",
      { url: 'https://claude.ai/oauth/authorize?code=true&state=x' },
    ],
    [
      'Enter code WXYZ-9876 at https://view.awsapps.com/start/#/device',
      { url: 'https://view.awsapps.com/start/#/device', code: 'WXYZ-9876' },
    ],
    ['Logged in as example on github.com (2025-09-01)', {}],
  ])('reads %j', (line, prompt) => {
    expect(readSignInPrompt(line)).toEqual(prompt);
  });
});

describe('trackSignInPrompt', () => {
  it('ignores output that arrives after the sign-in finished', () => {
    const progress: SignInProgress[] = [];
    const opened: string[] = [];
    const tracker = trackSignInPrompt({
      onProgress: (step) => progress.push(step),
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    tracker.report({ status: 'signed_in' });
    tracker.line(GH_OUTPUT[1] ?? '');
    expect(progress).toEqual([{ status: 'starting' }, { status: 'signed_in' }]);
    expect(opened).toEqual([]);
  });
});

describe('runLoginProcess', () => {
  it(
    'shows the code and URL, opens the URL once and succeeds on exit 0',
    async () => {
      const { outcome, progress, opened } = await run(
        printsThenExits([...GH_OUTPUT, GH_OUTPUT[1] ?? ''], 0),
      );
      expect(outcome).toEqual({ ok: true, via: 'gh auth login --web' });
      expect(progress).toEqual([
        { status: 'starting' },
        { status: 'waiting', code: 'ABCD-1234' },
        {
          status: 'waiting',
          code: 'ABCD-1234',
          url: 'https://github.com/login/device',
        },
        {
          status: 'signed_in',
          code: 'ABCD-1234',
          url: 'https://github.com/login/device',
        },
      ]);
      expect(opened).toEqual(['https://github.com/login/device']);
    },
    TIMEOUT,
  );

  it(
    'leaves the browser alone for a tool that opens it itself',
    async () => {
      const login = {
        ...printsThenExits(GH_OUTPUT, 0),
        opensBrowser: true,
      };
      const { outcome, opened } = await run(login);
      expect(outcome.ok).toBe(true);
      expect(opened).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'fails with the exit code and the last line it printed',
    async () => {
      const { outcome, progress } = await run(
        printsThenExits(['error connecting to github.com'], 1),
      );
      expect(outcome).toEqual({
        ok: false,
        reason:
          'gh auth login --web exited with 1: error connecting to github.com',
      });
      expect(progress.at(-1)).toEqual({
        status: 'failed',
        message:
          'gh auth login --web exited with 1: error connecting to github.com',
      });
    },
    TIMEOUT,
  );

  it('says the tool is not installed when it cannot be found', async () => {
    const { outcome } = await run(
      stub('', { command: 'quarterdeck-no-such-login' }),
    );
    expect(outcome).toEqual({
      ok: false,
      reason: 'quarterdeck-no-such-login is not installed',
    });
  });

  it(
    'stops a sign-in that never finishes',
    async () => {
      const { outcome } = await run(stub('setInterval(() => {}, 1000);'), 300);
      expect(outcome).toEqual({
        ok: false,
        reason: 'gh auth login --web did not finish within 0.3s',
      });
    },
    TIMEOUT,
  );

  it(
    'stops when cancelled',
    async () => {
      const controller = new AbortController();
      const running = runLoginProcess(stub('setInterval(() => {}, 1000);'), {
        signal: controller.signal,
      });
      controller.abort();
      expect(await running).toEqual({
        ok: false,
        reason: 'gh auth login --web was cancelled',
      });
    },
    TIMEOUT,
  );

  it(
    'passes the login its own env on top of the caller env',
    async () => {
      const { outcome } = await run(
        stub(
          'process.exit(process.env.QD_LOGIN === "yes" && process.env.QD_BASE === "kept" ? 0 : 3);',
          { env: { QD_LOGIN: 'yes' } },
        ),
      );
      expect(outcome.ok).toBe(false);
      const withBase = await runLoginProcess(
        stub(
          'process.exit(process.env.QD_LOGIN === "yes" && process.env.QD_BASE === "kept" ? 0 : 3);',
          { env: { QD_LOGIN: 'yes' } },
        ),
        { env: { ...process.env, QD_BASE: 'kept' } },
      );
      expect(withBase.ok).toBe(true);
    },
    TIMEOUT,
  );
});
