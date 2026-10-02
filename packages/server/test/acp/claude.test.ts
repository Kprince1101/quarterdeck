import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  CANCELLED_PERMISSION,
  CLAUDE_ADAPTER,
  CLAUDE_AGENT_ACP_PACKAGE,
  CLAUDE_AGENT_ACP_VERSION,
  CLAUDE_DEFAULT_MODE_ID,
  CLAUDE_INITIALIZE_TIMEOUT_MS,
  CLAUDE_PERMISSION_SETTINGS,
  ClaudePermissionSettingsError,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  NPM_PUBLIC_REGISTRY,
  claudeAgentCommand,
  claudeRuntimeDir,
  claudeVersionCommand,
  claudeSettingsFiles,
  createClaudeAdapter,
  findClaudeSettingsOverrides,
  isRepoAllowOverride,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  AgentCommand,
  ClaudeAdapterOptions,
  ClaudeSettingsOverride,
  RuntimeAdapter,
  RuntimeLaunch,
  SessionMeta,
} from '@quarterdeck/server';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { FAKE_DEFAULT_MODE_ID, fakeAgentLaunch } from './fake-agent/index.ts';
import { expectAllExited } from './process-check.ts';
import { describeRuntimeConformance } from './runtime-conformance.ts';

const PINNED = `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`;
const LOCKED_META = {
  claudeCode: {
    options: { settingSources: [], allowDangerouslySkipPermissions: false },
  },
};
const ALLOW_ALL = { permissions: { allow: ['Bash(*)'] } };
const ACCEPT_EDITS = { permissions: { defaultMode: 'acceptEdits' } };
const IS_WINDOWS = process.platform === 'win32';
const FAKE_CLAUDE_VERSION = '9.9.9 (Claude Code)';

const SILENT_AGENT: AgentCommand = {
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
};

const tempDirs: string[] = [];
const openClients: AcpClient[] = [];
const spawned: number[] = [];

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const writeJson = async (path: string, value: unknown) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

const writeScript = async (path: string, lines: string[]) => {
  await writeFile(path, ['#!/bin/sh', ...lines, ''].join('\n'), {
    mode: 0o755,
  });
};

interface SettingsDirs {
  cwd: string;
  config: string;
}

const connectClaude = async (
  launch: RuntimeLaunch,
  adapter: RuntimeAdapter = CLAUDE_ADAPTER,
) => {
  const events: AcpClientEvent[] = [];
  const client = await adapter.connect(launch, {
    clientName: 'quarterdeck-test',
    clientVersion: '0.0.0',
    onPermissionRequest: async () => CANCELLED_PERMISSION,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'spawned') spawned.push(event.pid);
    },
  });
  openClients.push(client);
  return { client, events };
};

const agentText = (events: AcpClientEvent[], sessionId: string): string =>
  events
    .flatMap((event) => {
      if (event.type !== 'session_update') return [];
      if (event.sessionId !== sessionId) return [];
      if (event.update.sessionUpdate !== 'agent_message_chunk') return [];
      if (event.update.content.type !== 'text') return [];
      return [event.update.content.text];
    })
    .join('');

const describeMode = async (
  client: AcpClient,
  events: AcpClientEvent[],
  sessionId: string,
): Promise<unknown> => {
  await client.prompt(sessionId, 'describe_mode');
  return JSON.parse(agentText(events, sessionId));
};

beforeAll(async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', await tempDir('qd-claude-config-'));
});

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await expectAllExited(spawned.splice(0));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describeRuntimeConformance(CLAUDE_ADAPTER);

describe('claude adapter command', () => {
  it('is the claude runtime', () => {
    expect(CLAUDE_ADAPTER.runtime).toBe('claude');
  });

  it('runs the pinned claude-agent-acp through npx', () => {
    expect(claudeAgentCommand('darwin')).toEqual({
      command: 'npx',
      args: ['--yes', PINNED],
    });
    expect(claudeAgentCommand('linux')).toEqual(claudeAgentCommand('darwin'));
  });

  it('pins an exact version', () => {
    expect(CLAUDE_AGENT_ACP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('goes through the shell on Windows, where npx is a .cmd shim', () => {
    const { command, args } = claudeAgentCommand('win32');
    expect(command).toMatch(/cmd(\.exe)?$/i);
    expect(args).toEqual(['/d', '/s', '/c', 'npx', '--yes', PINNED]);
  });

  it('asks the pinned package, offline, for its bundled Claude Code version', () => {
    expect(claudeVersionCommand('linux')).toEqual({
      command: 'npx',
      args: ['--yes', '--offline', PINNED, '--cli', '--version'],
    });
    expect(claudeVersionCommand('win32').args).toEqual([
      '/d',
      '/s',
      '/c',
      'npx',
      '--yes',
      '--offline',
      PINNED,
      '--cli',
      '--version',
    ]);
  });

  it('runs npx from the Quarterdeck runtime folder, never the session cwd', () => {
    const command = CLAUDE_ADAPTER.command({ cwd: '/work/deck' });
    expect(command.cwd).toBe(claudeRuntimeDir());
    expect(command.cwd).not.toBe('/work/deck');
    expect(claudeRuntimeDir('/home/q/.quarterdeck')).toBe(
      join('/home/q/.quarterdeck', 'runtimes', 'claude'),
    );
  });

  it('fetches from the public npm registry and keeps the launch env', () => {
    const env = { PATH: '/usr/bin', npm_config_registry: 'https://evil.test/' };
    expect(CLAUDE_ADAPTER.command({ cwd: '/work/deck', env }).env).toEqual({
      PATH: '/usr/bin',
      npm_config_registry: NPM_PUBLIC_REGISTRY,
    });
  });

  it('ignores the kiro agent name', () => {
    expect(
      CLAUDE_ADAPTER.command({ cwd: tmpdir(), agentName: 'builder' }).args,
    ).not.toContain('builder');
  });

  it('waits longer than the default for initialize, for the first npx fetch', () => {
    expect(CLAUDE_INITIALIZE_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_INITIALIZE_TIMEOUT_MS,
    );
  });

  it('lets the caller set its own initialize deadline', async () => {
    const started = Date.now();
    await expect(
      CLAUDE_ADAPTER.connect(
        { cwd: await tempDir('qd-claude-silent-'), command: SILENT_AGENT },
        {
          clientName: 'quarterdeck-test',
          clientVersion: '0.0.0',
          onPermissionRequest: async () => CANCELLED_PERMISSION,
          initializeTimeoutMs: 200,
        },
      ),
    ).rejects.toMatchObject({ code: 'initialize_timeout' });
    expect(Date.now() - started).toBeLessThan(DEFAULT_INITIALIZE_TIMEOUT_MS);
  });
});

describe('claude adapter permission lock', () => {
  it('uses the same default mode id as claude-agent-acp', () => {
    expect(CLAUDE_DEFAULT_MODE_ID).toBe(FAKE_DEFAULT_MODE_ID);
  });

  it('starts every new session in default mode with Claude settings ignored', async () => {
    const cwd = await tempDir('qd-claude-session-');
    const { client, events } = await connectClaude({
      cwd,
      command: fakeAgentLaunch(),
    });
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] });

    expect(await describeMode(client, events, sessionId)).toEqual({
      modeId: CLAUDE_DEFAULT_MODE_ID,
      meta: LOCKED_META,
    });
  });

  it('keeps caller meta but overrides the locked options', async () => {
    const cwd = await tempDir('qd-claude-session-');
    const { client, events } = await connectClaude({
      cwd,
      command: fakeAgentLaunch(),
    });
    const meta: SessionMeta = {
      trace: 't-1',
      claudeCode: {
        options: { model: 'opus', settingSources: ['user', 'local'] },
      },
    };
    const { sessionId } = await client.newSession({
      cwd,
      mcpServers: [],
      meta,
    });

    expect(await describeMode(client, events, sessionId)).toEqual({
      modeId: CLAUDE_DEFAULT_MODE_ID,
      meta: {
        trace: 't-1',
        claudeCode: {
          options: {
            model: 'opus',
            settingSources: [],
            allowDangerouslySkipPermissions: false,
          },
        },
      },
    });
  });

  it.each([
    ['session/resume', { supportsResume: true }],
    ['session/load', { supportsLoad: true }],
  ])('locks a session resumed with %s', async (method, agent) => {
    const cwd = await tempDir('qd-claude-session-');
    const { client, events } = await connectClaude({
      cwd,
      command: fakeAgentLaunch(agent),
    });
    const resumed = await client.resumeSession({
      sessionId: 'fake-session-7',
      cwd,
      mcpServers: [],
    });

    expect(resumed.method).toBe(method);
    expect(await describeMode(client, events, resumed.sessionId)).toEqual({
      modeId: CLAUDE_DEFAULT_MODE_ID,
      meta: LOCKED_META,
    });
  });
});

describe('claude settings that would skip the project rules', () => {
  it('reads the user, project and local settings files', async () => {
    expect(
      claudeSettingsFiles('/work/deck', { CLAUDE_CONFIG_DIR: '/c' }),
    ).toEqual([
      { path: join('/c', 'settings.json'), tier: 'user' },
      { path: join('/work/deck', '.claude', 'settings.json'), tier: 'project' },
      {
        path: join('/work/deck', '.claude', 'settings.local.json'),
        tier: 'local',
      },
    ]);
  });

  it('treats repo allow rules and unreadable repo files as unlockable', () => {
    const override = (
      tier: ClaudeSettingsOverride['tier'],
      kind: ClaudeSettingsOverride['kind'],
    ): ClaudeSettingsOverride => ({ path: '/p', tier, kind, reason: 'r' });

    expect(isRepoAllowOverride(override('local', 'allow'))).toBe(true);
    expect(isRepoAllowOverride(override('project', 'unreadable'))).toBe(true);
    expect(isRepoAllowOverride(override('project', 'default_mode'))).toBe(
      false,
    );
    expect(isRepoAllowOverride(override('user', 'allow'))).toBe(false);
  });

  it('finds allow rules, a non-default mode and unreadable JSON', async () => {
    const config = await tempDir('qd-claude-config-');
    const cwd = await tempDir('qd-claude-session-');
    await writeJson(join(config, 'settings.json'), ALLOW_ALL);
    await writeJson(join(cwd, '.claude', 'settings.local.json'), ACCEPT_EDITS);
    await writeFile(join(cwd, '.claude', 'settings.json'), '{ nope');

    const overrides = await findClaudeSettingsOverrides(cwd, {
      CLAUDE_CONFIG_DIR: config,
    });

    expect(overrides).toEqual([
      {
        path: join(config, 'settings.json'),
        tier: 'user',
        kind: 'allow',
        reason: 'permissions.allow has 1 rule(s)',
      },
      {
        path: join(cwd, '.claude', 'settings.json'),
        tier: 'project',
        kind: 'unreadable',
        reason: expect.stringMatching(/^not valid JSON/),
      },
      {
        path: join(cwd, '.claude', 'settings.local.json'),
        tier: 'local',
        kind: 'default_mode',
        reason: 'permissions.defaultMode is "acceptEdits"',
      },
    ]);
  });

  it.each([
    ['no settings', undefined],
    ['default mode', { permissions: { defaultMode: 'default' } }],
    ['manual mode', { permissions: { defaultMode: 'Manual' } }],
    ['empty allow and deny rules', { permissions: { allow: [], deny: ['X'] } }],
  ])('accepts %s', async (_name, settings) => {
    const cwd = await tempDir('qd-claude-session-');
    if (settings)
      await writeJson(join(cwd, '.claude', 'settings.json'), settings);

    expect(
      await findClaudeSettingsOverrides(cwd, { CLAUDE_CONFIG_DIR: cwd }),
    ).toEqual([]);
  });

  it('refuses before launch when a custom command cannot be locked', async () => {
    const config = await tempDir('qd-claude-config-');
    const cwd = await tempDir('qd-claude-session-');
    await writeJson(join(config, 'settings.json'), ALLOW_ALL);
    const events: AcpClientEvent[] = [];

    const refused = CLAUDE_ADAPTER.connect(
      {
        cwd,
        env: { ...process.env, CLAUDE_CONFIG_DIR: config },
        command: fakeAgentLaunch(),
      },
      {
        clientName: 'quarterdeck-test',
        clientVersion: '0.0.0',
        onPermissionRequest: async () => CANCELLED_PERMISSION,
        onEvent: (event) => events.push(event),
      },
    );

    await expect(refused).rejects.toBeInstanceOf(ClaudePermissionSettingsError);
    await expect(refused).rejects.toMatchObject({
      code: CLAUDE_PERMISSION_SETTINGS,
      overrides: [
        {
          path: join(config, 'settings.json'),
          reason: 'permissions.allow has 1 rule(s)',
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it('refuses a session cwd whose local settings change the mode', async () => {
    const cwd = await tempDir('qd-claude-session-');
    await writeJson(join(cwd, '.claude', 'settings.local.json'), ACCEPT_EDITS);

    await expect(
      connectClaude({ cwd, command: fakeAgentLaunch() }),
    ).rejects.toMatchObject({ code: CLAUDE_PERMISSION_SETTINGS });
  });
});

describe.skipIf(IS_WINDOWS)('claude adapter default npx path', () => {
  const pinnedPath = async (adapterOptions: ClaudeAdapterOptions = {}) => {
    const bin = await tempDir('qd-claude-bin-');
    const processDir = await tempDir('qd-claude-runtime-');
    const cwd = await tempDir('qd-claude-session-');
    const config = await tempDir('qd-claude-config-');
    const agent = fakeAgentLaunch();
    await writeScript(join(bin, 'npx'), [
      `if [ "$*" = "${claudeVersionCommand().args.join(' ')}" ]; then`,
      `  echo "${FAKE_CLAUDE_VERSION} from $(pwd -P)"`,
      '  exit 0',
      'fi',
      'echo "npx cwd=$(pwd -P) registry=$npm_config_registry args=$*" >&2',
      `exec '${agent.command}' ${agent.args.map((arg) => `'${arg}'`).join(' ')}`,
    ]);
    const launch: RuntimeLaunch = {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: config,
        PATH: `${bin}${delimiter}${process.env['PATH']}`,
      },
    };
    const adapter = createClaudeAdapter({ processDir, ...adapterOptions });
    return { adapter, launch, cwd, config, processDir };
  };

  it('runs npx in its own folder with the npmjs registry and logs the bundled CLI version', async () => {
    const { adapter, launch, processDir } = await pinnedPath();

    const { events } = await connectClaude(launch, adapter);

    expect(events).toContainEqual({
      type: 'stderr',
      line: `npx cwd=${processDir} registry=${NPM_PUBLIC_REGISTRY} args=--yes ${PINNED}`,
    });
    const versions = events.filter((event) => event.type === 'agent_version');
    expect(versions.map((event) => event.stage)).toEqual([
      'before_spawn',
      'after_spawn',
    ]);
    versions.forEach((event) => {
      expect(event).toMatchObject({
        command: 'npx',
        version: `${FAKE_CLAUDE_VERSION} from ${processDir}`,
      });
    });
  });

  it('refuses before launch when the worktree settings allow tools', async () => {
    const { adapter, launch, cwd } = await pinnedPath();
    await writeJson(join(cwd, '.claude', 'settings.local.json'), ALLOW_ALL);
    const events: AcpClientEvent[] = [];

    await expect(
      adapter.connect(launch, {
        clientName: 'quarterdeck-test',
        clientVersion: '0.0.0',
        onPermissionRequest: async () => CANCELLED_PERMISSION,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_PERMISSION_SETTINGS,
      overrides: [
        {
          path: join(cwd, '.claude', 'settings.local.json'),
          tier: 'local',
          kind: 'allow',
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it.each([
    [
      'a worktree default mode',
      (dirs: SettingsDirs) => join(dirs.cwd, '.claude', 'settings.json'),
      ACCEPT_EDITS,
    ],
    [
      'user allow rules',
      (dirs: SettingsDirs) => join(dirs.config, 'settings.json'),
      ALLOW_ALL,
    ],
  ])('locks the session despite %s', async (_name, settingsPath, settings) => {
    const { adapter, launch, cwd, config } = await pinnedPath();
    await writeJson(settingsPath({ cwd, config }), settings);

    const { client, events } = await connectClaude(launch, adapter);
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] });

    expect(await describeMode(client, events, sessionId)).toEqual({
      modeId: CLAUDE_DEFAULT_MODE_ID,
      meta: LOCKED_META,
    });
  });

  it('relies on the _meta lock alone when repo refusal is off', async () => {
    const { adapter, launch, cwd } = await pinnedPath({
      refuseRepoAllowRules: false,
    });
    await writeJson(join(cwd, '.claude', 'settings.local.json'), ALLOW_ALL);

    const { client, events } = await connectClaude(launch, adapter);
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] });

    expect(await describeMode(client, events, sessionId)).toEqual({
      modeId: CLAUDE_DEFAULT_MODE_ID,
      meta: LOCKED_META,
    });
  });
});
