import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  CANCELLED_PERMISSION,
  childEnv,
  createGeminiAdapter,
  defaultGeminiDir,
  GEMINI_ADAPTER,
  GEMINI_ADMIN_POLICY,
  GEMINI_ADMIN_POLICY_CARD,
  GEMINI_COMMAND,
  GEMINI_SYSTEM_SETTINGS,
  GEMINI_SYSTEM_SETTINGS_ENV,
  GEMINI_TRUST_WORKSPACE_ENV,
  GeminiAdminPolicyError,
  geminiPaths,
  isAuthRequiredError,
  isGeminiCommand,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  LaunchOptions,
  SessionUpdateEvent,
} from '@quarterdeck/server';
import { afterAll, describe, expect, it } from 'vitest';
import { agentText } from './conformance/updates.ts';
import { FAKE_AGENT_NAME, fakeAgentLaunch } from './fake-agent/index.ts';
import { describeRuntimeConformance } from './runtime-conformance.ts';

const LIVE =
  process.env['QUARTERDECK_LIVE'] === '1' ||
  process.env['QUARTERDECK_GEMINI_LIVE'] === '1';
const LIVE_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 10_000;
const LIVE_WORD = 'quarterdeck';
const LIVE_SHELL = 'echo quarterdeck-shell';
const LIVE_PROBE = 'quarterdeck-gemini-probe.txt';
const IS_WINDOWS = process.platform === 'win32';

const ENV_AGENT = fileURLToPath(
  new URL('gemini-fixtures/env-agent.ts', import.meta.url),
);

const scratch = mkdtempSync(resolve(tmpdir(), 'quarterdeck-gemini-'));
const geminiDir = join(scratch, 'gemini');
const noSystemConfig = join(scratch, 'no-system-config');
const worktree = join(scratch, 'worktree');
mkdirSync(worktree);
const paths = geminiPaths(geminiDir);
const testAdapter = createGeminiAdapter({
  dir: geminiDir,
  systemConfigDir: noSystemConfig,
});

afterAll(() => rm(scratch, { recursive: true, force: true }));

const geminiInstalled = (): boolean => {
  const probe = spawnSync(GEMINI_COMMAND, ['--version'], {
    timeout: VERSION_TIMEOUT_MS,
  });
  return probe.error === undefined && probe.status === 0;
};

const clientOptions = (
  overrides: Partial<LaunchOptions> = {},
): LaunchOptions => ({
  clientName: 'quarterdeck-gemini-test',
  clientVersion: '0.0.0',
  spawnRetries: 0,
  onPermissionRequest: async () => CANCELLED_PERMISSION,
  ...overrides,
});

describeRuntimeConformance(testAdapter, { cwd: worktree });

describe('gemini adapter command', () => {
  const env = {
    source: {
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'key',
      GH_TOKEN: 'gh-secret',
      [GEMINI_TRUST_WORKSPACE_ENV]: 'true',
    },
  };

  it('runs Gemini CLI in native ACP mode from the Quarterdeck gemini folder', () => {
    const command = testAdapter.command({ cwd: '/work/deck', env });
    expect({ ...command, env: childEnv(command.env) }).toEqual({
      command: 'gemini',
      args: [
        '--acp',
        '--approval-mode',
        'default',
        '--admin-policy',
        paths.adminPolicy,
      ],
      cwd: geminiDir,
      env: {
        PATH: '/usr/bin',
        GEMINI_API_KEY: 'key',
        [GEMINI_SYSTEM_SETTINGS_ENV]: paths.systemSettings,
        [GEMINI_TRUST_WORKSPACE_ENV]: 'false',
      },
    });
  });

  it('keeps Quarterdeck-owned files under ~/.quarterdeck/gemini', () => {
    expect(defaultGeminiDir()).toMatch(/\.quarterdeck[/\\]gemini$/);
    const command = GEMINI_ADAPTER.command({ cwd: tmpdir(), env });
    expect(command.cwd).toBe(defaultGeminiDir());
    expect(childEnv(command.env)).toMatchObject({
      [GEMINI_SYSTEM_SETTINGS_ENV]:
        geminiPaths(defaultGeminiDir()).systemSettings,
    });
  });

  it('asks before every tool instead of trusting them', () => {
    const { args } = testAdapter.command({ cwd: tmpdir(), env });
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('-y');
    expect(args).not.toContain('--allowed-tools');
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('default');
  });

  it('ignores the kiro project and agent name', () => {
    expect(
      testAdapter.command({
        cwd: tmpdir(),
        env,
        project: 'deck',
        agentName: 'builder',
      }).args,
    ).toEqual(testAdapter.command({ cwd: tmpdir(), env }).args);
  });

  it('recognises a gemini binary by name', () => {
    expect(isGeminiCommand('gemini')).toBe(true);
    expect(isGeminiCommand('/opt/gemini/bin/gemini')).toBe(true);
    expect(isGeminiCommand('C:\\tools\\gemini.cmd')).toBe(true);
    expect(isGeminiCommand(process.execPath)).toBe(false);
    expect(isGeminiCommand('gemini-wrapper')).toBe(false);
  });
});

interface EnvReport {
  cwd: string;
  args: string[];
  systemSettings?: string;
  trustWorkspace?: string;
}

const writeGeminiShim = async (): Promise<string> => {
  const bin = join(scratch, 'bin');
  await mkdir(bin, { recursive: true });
  const shim = join(bin, 'gemini');
  const nodeFlags = fakeAgentLaunch().args.filter((arg) =>
    arg.startsWith('--'),
  );
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      `exec "${process.execPath}" ${nodeFlags.join(' ')} "${ENV_AGENT}" "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
  return shim;
};

const readReport = async (marker: string): Promise<EnvReport> =>
  JSON.parse(await readFile(marker, 'utf8')) as EnvReport;

describe('gemini adapter launch', () => {
  it.skipIf(IS_WINDOWS)(
    'runs a gemini override from its own folder with the lockdown and admin policy',
    async () => {
      const marker = join(scratch, 'env-marker.json');
      const events: AcpClientEvent[] = [];
      const client = await testAdapter.connect(
        {
          cwd: worktree,
          env: { set: { QUARTERDECK_ENV_MARKER: marker } },
          command: { command: await writeGeminiShim(), args: ['--acp'] },
        },
        clientOptions({ onEvent: (event) => events.push(event) }),
      );
      await client.close();
      const report = await readReport(marker);
      expect(report).toEqual({
        cwd: await realpath(geminiDir),
        args: ['--acp', '--admin-policy', paths.adminPolicy],
        systemSettings: paths.systemSettings,
        trustWorkspace: 'false',
      });
      expect(
        events.flatMap((event) => {
          if (event.type !== 'agent_version') return [];
          return [`${event.stage} ${event.version}`];
        }),
      ).toEqual([
        'before_spawn gemini-fixture 0.0.0',
        'after_spawn gemini-fixture 0.0.0',
      ]);
    },
  );

  it('keeps the lockdown env on an override that is not gemini, without the flag', async () => {
    const marker = join(scratch, 'node-marker.json');
    const fake = fakeAgentLaunch();
    const client = await testAdapter.connect(
      {
        cwd: worktree,
        env: { set: { QUARTERDECK_ENV_MARKER: marker } },
        command: {
          command: fake.command,
          args: fake.args.map((arg) => {
            if (arg.endsWith('main.ts')) return ENV_AGENT;
            return arg;
          }),
        },
      },
      clientOptions(),
    );
    await client.close();
    const report = await readReport(marker);
    expect(report.args).not.toContain('--admin-policy');
    expect(report).toMatchObject({
      cwd: await realpath(geminiDir),
      systemSettings: paths.systemSettings,
      trustWorkspace: 'false',
    });
  });
});

describe('gemini adapter lockdown', () => {
  it('writes the system settings and admin policy before it spawns', async () => {
    const client = await testAdapter.connect(
      { cwd: worktree, command: fakeAgentLaunch() },
      clientOptions(),
    );
    await client.close();
    expect(client.agent.agentInfo?.name).toBe(FAKE_AGENT_NAME);
    expect(JSON.parse(await readFile(paths.systemSettings, 'utf8'))).toEqual(
      GEMINI_SYSTEM_SETTINGS,
    );
    expect(GEMINI_SYSTEM_SETTINGS).toMatchObject({
      tools: { allowed: [] },
      security: { disableYoloMode: true, disableAlwaysAllow: true },
      advanced: { ignoreLocalEnv: true },
    });
    expect(await readFile(paths.adminPolicy, 'utf8')).toBe(GEMINI_ADMIN_POLICY);
  });

  it('rewrites a lockdown file an agent edited', async () => {
    await writeFile(
      paths.systemSettings,
      JSON.stringify({ tools: { allowed: ['run_shell_command'] } }),
    );
    await writeFile(paths.adminPolicy, '');
    const client = await testAdapter.connect(
      { cwd: worktree, command: fakeAgentLaunch() },
      clientOptions(),
    );
    await client.close();
    expect(JSON.parse(await readFile(paths.systemSettings, 'utf8'))).toEqual(
      GEMINI_SYSTEM_SETTINGS,
    );
    expect(await readFile(paths.adminPolicy, 'utf8')).toBe(GEMINI_ADMIN_POLICY);
  });

  it('refuses an admin-set system settings path without spawning', async () => {
    const events: string[] = [];
    const launch = {
      cwd: worktree,
      env: {
        source: {
          ...process.env,
          [GEMINI_SYSTEM_SETTINGS_ENV]: '/etc/corp/gemini.json',
        },
      },
      command: fakeAgentLaunch(),
    };
    const err: unknown = await testAdapter
      .connect(launch, clientOptions({ onEvent: (e) => events.push(e.type) }))
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(GeminiAdminPolicyError);
    expect(err).toMatchObject({
      cardKind: GEMINI_ADMIN_POLICY_CARD,
      source: 'env',
      path: '/etc/corp/gemini.json',
    });
    expect(events).toEqual([]);
  });

  it('refuses a system settings file it would silently replace', async () => {
    const systemConfigDir = join(scratch, 'system-settings');
    await mkdir(systemConfigDir, { recursive: true });
    await writeFile(join(systemConfigDir, 'settings.json'), '{}');
    await expect(
      createGeminiAdapter({ dir: geminiDir, systemConfigDir }).connect(
        { cwd: worktree, command: fakeAgentLaunch() },
        clientOptions(),
      ),
    ).rejects.toMatchObject({
      source: 'system_settings',
      path: join(systemConfigDir, 'settings.json'),
    });
  });

  it('refuses system policies that would shadow the admin policy', async () => {
    const systemConfigDir = join(scratch, 'system-policies');
    await mkdir(join(systemConfigDir, 'policies'), { recursive: true });
    await writeFile(join(systemConfigDir, 'policies', 'corp.toml'), '');
    await expect(
      createGeminiAdapter({ dir: geminiDir, systemConfigDir }).connect(
        { cwd: worktree, command: fakeAgentLaunch() },
        clientOptions(),
      ),
    ).rejects.toMatchObject({
      source: 'system_policies',
      path: join(systemConfigDir, 'policies', 'corp.toml'),
    });
  });
});

const selectKind = (
  request: RequestPermissionRequest,
  kind: 'allow_once' | 'reject_once',
): RequestPermissionResponse => {
  const option = request.options.find((candidate) => candidate.kind === kind);
  if (!option) return CANCELLED_PERMISSION;
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
};

const allowEditsOnly = async (
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> => {
  if (request.toolCall.kind === 'edit')
    return selectKind(request, 'allow_once');
  return selectKind(request, 'reject_once');
};

const openLiveSession = (client: AcpClient, cwd: string) =>
  client.newSession({ cwd, mcpServers: [] }).then(
    ({ sessionId }) => sessionId,
    (err: unknown) => {
      if (isAuthRequiredError(err)) return undefined;
      throw err;
    },
  );

const allowShellInWorkspace = async (cwd: string) => {
  await mkdir(join(cwd, '.gemini'), { recursive: true });
  await writeFile(
    join(cwd, '.gemini', 'settings.json'),
    JSON.stringify({ tools: { allowed: ['run_shell_command'] } }),
  );
};

const isShellRequest = (request: RequestPermissionRequest) =>
  request.toolCall.kind === 'execute' ||
  (request.toolCall.title ?? '').includes('quarterdeck-shell');

describe.skipIf(!LIVE || !geminiInstalled())(
  'gemini adapter live (signed-in gemini)',
  () => {
    it(
      'answers, asks before a workspace-allowed shell command and writes in the session cwd',
      async ({ skip }) => {
        const cwd = await mkdtemp(
          resolve(tmpdir(), 'quarterdeck-gemini-live-'),
        );
        const liveDir = join(scratch, 'live-gemini');
        const updates: SessionUpdateEvent[] = [];
        const permissions: RequestPermissionRequest[] = [];
        let client: AcpClient | undefined;
        try {
          await allowShellInWorkspace(cwd);
          client = await createGeminiAdapter({ dir: liveDir })
            .connect(
              { cwd },
              clientOptions({
                onPermissionRequest: (request) => {
                  permissions.push(request);
                  return allowEditsOnly(request);
                },
                onEvent: (event) => {
                  if (event.type === 'session_update') updates.push(event);
                },
              }),
            )
            .catch((err: unknown) => {
              if (err instanceof GeminiAdminPolicyError) return undefined;
              throw err;
            });
          if (!client) {
            skip('gemini runs under an administrator policy here');
            return;
          }
          const sessionId = await openLiveSession(client, cwd);
          if (sessionId === undefined) {
            skip('gemini is installed but not signed in');
            return;
          }

          const { stopReason } = await client.prompt(
            sessionId,
            `Do not use any tools. Reply with the single word ${LIVE_WORD}.`,
          );
          expect(stopReason).toBe('end_turn');
          expect(agentText(updates, sessionId).toLowerCase()).toContain(
            LIVE_WORD,
          );

          await client.prompt(
            sessionId,
            `Use run_shell_command to run exactly: ${LIVE_SHELL}`,
          );
          expect(
            permissions.some(
              (request) =>
                request.sessionId === sessionId && isShellRequest(request),
            ),
            'the workspace tools.allowed entry must not skip the permission request',
          ).toBe(true);

          await client.prompt(
            sessionId,
            `Use write_file to create ${LIVE_PROBE} in the current directory containing ${LIVE_WORD}.`,
          );
          expect(existsSync(join(cwd, LIVE_PROBE))).toBe(true);
          expect(existsSync(join(liveDir, LIVE_PROBE))).toBe(false);
        } finally {
          await client?.close();
          await rm(cwd, { recursive: true, force: true });
        }
      },
      LIVE_TIMEOUT_MS,
    );
  },
);
