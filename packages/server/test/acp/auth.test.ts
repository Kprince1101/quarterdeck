import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_AUTH_METHODS,
  CLAUDE_AGENT_ACP_PACKAGE,
  CLAUDE_AGENT_ACP_VERSION,
  RUNTIME_SIGN_IN_NAMES,
  runtimeSignInTarget,
  signInOverAcp,
  signInRuntime,
  spawnAcpClient,
  withRuntimeSignIn,
  defineRuntimeAdapter,
  type AcpSignInTarget,
  type SignInProgress,
} from '@quarterdeck/server';
import {
  FAKE_AUTH_METHOD_ID,
  FAKE_SIGN_IN_CODE,
  FAKE_SIGN_IN_URL,
  FAKE_TERMINAL_AUTH_METHOD_ID,
  FAKE_TERMINAL_LOGIN_ARG,
  FAKE_TERMINAL_LOGIN_FAILS_ARG,
  fakeAgentLaunch,
} from './fake-agent/index.ts';
import type { FakeAgentOptions } from './fake-agent/index.ts';

const TIMEOUT = 30_000;

const target = (
  methodId: string,
  options: FakeAgentOptions = {},
  extra: Partial<AcpSignInTarget> = {},
): AcpSignInTarget => ({
  displayName: 'Fake',
  methodId,
  agent: fakeAgentLaunch(options),
  opensBrowser: false,
  ...extra,
});

const recorder = () => {
  const progress: SignInProgress[] = [];
  const opened: string[] = [];
  return {
    progress,
    opened,
    options: {
      onProgress: (step: SignInProgress) => progress.push(step),
      openUrl: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  };
};

describe('ACP sign-in driver', () => {
  it(
    'signs in through ACP authenticate with the pinned agent method',
    async () => {
      const run = recorder();
      const outcome = await signInOverAcp(
        target(FAKE_AUTH_METHOD_ID, { requireAuth: true, authPrompt: true }),
        run.options,
      );
      expect(outcome).toEqual({
        ok: true,
        via: `ACP authenticate ${FAKE_AUTH_METHOD_ID}`,
      });
      expect(run.progress.at(0)).toEqual({ status: 'starting' });
      expect(run.progress.at(-1)).toEqual({
        status: 'signed_in',
        url: FAKE_SIGN_IN_URL,
        code: FAKE_SIGN_IN_CODE,
      });
      expect(run.opened).toEqual([FAKE_SIGN_IN_URL]);
    },
    TIMEOUT,
  );

  it(
    'leaves the browser to a runtime that opens it itself',
    async () => {
      const run = recorder();
      const outcome = await signInOverAcp(
        target(
          FAKE_AUTH_METHOD_ID,
          { authPrompt: true },
          { opensBrowser: true },
        ),
        run.options,
      );
      expect(outcome.ok).toBe(true);
      expect(run.progress.some(({ code }) => code === FAKE_SIGN_IN_CODE)).toBe(
        true,
      );
      expect(run.opened).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'runs a terminal method as the agent invocation plus its args, never through authenticate',
    async () => {
      const run = recorder();
      const fake = target(FAKE_TERMINAL_AUTH_METHOD_ID, { terminalAuth: true });
      const outcome = await signInOverAcp(fake, run.options);
      expect(outcome).toEqual({
        ok: true,
        via: [
          fake.agent.command,
          ...fake.agent.args,
          FAKE_TERMINAL_LOGIN_ARG,
        ].join(' '),
      });
      expect(run.progress.at(-1)).toMatchObject({
        status: 'signed_in',
        url: FAKE_SIGN_IN_URL,
        code: FAKE_SIGN_IN_CODE,
      });
      expect(run.opened).toEqual([FAKE_SIGN_IN_URL]);
    },
    TIMEOUT,
  );

  it(
    'reports why when the terminal method exits non-zero',
    async () => {
      const run = recorder();
      const launch = fakeAgentLaunch({ terminalAuth: true });
      const outcome = await signInOverAcp(
        target(
          FAKE_TERMINAL_AUTH_METHOD_ID,
          {},
          {
            agent: {
              ...launch,
              args: [...launch.args, FAKE_TERMINAL_LOGIN_FAILS_ARG],
            },
          },
        ),
        run.options,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toContain('exited with 2');
      expect(outcome.reason).toContain(FAKE_SIGN_IN_URL);
      expect(run.progress.at(-1)).toMatchObject({
        status: 'failed',
        message: outcome.reason,
      });
    },
    TIMEOUT,
  );

  it(
    'names the methods the agent offers when the pinned one is missing',
    async () => {
      const outcome = await signInOverAcp(target('claude-ai-login'));
      expect(outcome).toEqual({
        ok: false,
        reason: `Fake does not offer the claude-ai-login sign-in (it offers: ${FAKE_AUTH_METHOD_ID})`,
      });
    },
    TIMEOUT,
  );

  it('fails with why when the agent does not start', async () => {
    const outcome = await signInOverAcp(
      target(
        FAKE_AUTH_METHOD_ID,
        {},
        { agent: { command: 'quarterdeck-no-such-agent', args: [] } },
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/^Fake did not start: /);
  });

  it(
    'advertises terminal auth on initialize, so agents list their terminal methods',
    async () => {
      const client = await spawnAcpClient(
        fakeAgentLaunch({ terminalAuth: true }),
        {
          clientName: 'test',
          clientVersion: '0.0.0',
          onPermissionRequest: () =>
            Promise.reject(new Error('no permission expected')),
        },
      );
      try {
        expect(client.agent.authMethods?.map(({ id }) => id)).toEqual([
          FAKE_TERMINAL_AUTH_METHOD_ID,
          FAKE_AUTH_METHOD_ID,
        ]);
      } finally {
        await client.close();
      }
    },
    TIMEOUT,
  );
});

describe('runtime sign-in drivers', () => {
  it('pins the browser method each runtime advertises', () => {
    expect(BROWSER_AUTH_METHODS).toEqual({
      claude: 'claude-ai-login',
      kiro: 'kiro-login',
      gemini: 'oauth-personal',
    });
  });

  it('starts each runtime ACP agent in a folder Quarterdeck owns', () => {
    const home = '/home/me/.quarterdeck';
    const claude = runtimeSignInTarget('claude', { home, platform: 'linux' });
    expect(claude.agent).toEqual({
      command: 'npx',
      args: [
        '--yes',
        `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`,
      ],
      cwd: '/home/me/.quarterdeck/runtimes/claude',
      env: { set: { npm_config_registry: 'https://registry.npmjs.org/' } },
    });
    expect(claude.methodId).toBe('claude-ai-login');
    expect(runtimeSignInTarget('kiro', { home, platform: 'linux' })).toEqual({
      displayName: RUNTIME_SIGN_IN_NAMES.kiro,
      methodId: 'kiro-login',
      agent: { command: 'kiro-cli', args: ['acp'], cwd: `${home}/kiro` },
      opensBrowser: true,
    });
    expect(
      runtimeSignInTarget('gemini', { home, platform: 'linux' }).agent,
    ).toEqual({ command: 'gemini', args: ['--acp'], cwd: `${home}/gemini` });
  });

  it('does not run the claude.ai sign-in outside the subscription auth mode', async () => {
    const progress = vi.fn();
    const outcome = await signInRuntime('claude', {
      env: { ...process.env, QUARTERDECK_CLAUDE_AUTH: 'api_key' },
      onProgress: progress,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(
      /^Claude runs in the api_key auth mode, which the claude\.ai sign-in does not change\. Export ANTHROPIC_API_KEY/,
    );
    expect(progress).toHaveBeenCalledWith({
      status: 'failed',
      message: outcome.reason,
    });
  });

  it(
    'signs a custom command in with the runtime pinned method',
    async () => {
      const outcome = await signInRuntime('claude', {
        command: fakeAgentLaunch(),
      });
      expect(outcome).toEqual({
        ok: false,
        reason: `Claude Code does not offer the claude-ai-login sign-in (it offers: ${FAKE_AUTH_METHOD_ID})`,
      });
    },
    TIMEOUT,
  );

  it(
    'gives every client an adapter connects the runtime sign-in driver',
    async () => {
      const fake = fakeAgentLaunch();
      const adapter = withRuntimeSignIn(
        defineRuntimeAdapter({
          runtime: 'gemini',
          displayName: 'Fake Gemini',
          command: () => fake,
        }),
      );
      const client = await adapter.connect(
        { cwd: process.cwd(), command: fake },
        {
          clientName: 'test',
          clientVersion: '0.0.0',
          onPermissionRequest: () =>
            Promise.reject(new Error('no permission expected')),
        },
      );
      try {
        const progress = vi.fn();
        const reason = `Gemini CLI does not offer the oauth-personal sign-in (it offers: ${FAKE_AUTH_METHOD_ID})`;
        expect(await client.signIn?.({ onProgress: progress })).toEqual({
          ok: false,
          reason,
        });
        expect(progress).toHaveBeenLastCalledWith({
          status: 'failed',
          message: reason,
        });
      } finally {
        await client.close();
      }
    },
    TIMEOUT,
  );
});
