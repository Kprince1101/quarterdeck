import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { quarterdeckHome } from '../../store/paths.js';
import type { AcpClient, AgentCommand, SessionMeta } from '../client/types.js';
import { defineRuntimeAdapter } from './adapter.js';
import type { RuntimeAdapter, RuntimeLaunch } from './adapter.js';
import {
  ClaudePermissionSettingsError,
  findClaudeSettingsOverrides,
} from './claude-settings.js';

export const CLAUDE_AGENT_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
export const CLAUDE_AGENT_ACP_VERSION = '0.85.0';
export const CLAUDE_INITIALIZE_TIMEOUT_MS = 300_000;
export const CLAUDE_DEFAULT_MODE_ID = 'default';
export const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

export const CLAUDE_LOCKED_OPTIONS = {
  settingSources: [],
  allowDangerouslySkipPermissions: false,
} as const;

const NPX_ARGS = [
  '--yes',
  `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`,
];

export const claudeRuntimeDir = (home: string = quarterdeckHome()): string =>
  join(home, 'runtimes', 'claude');

const npxThroughWindowsShell = (): AgentCommand => ({
  command: process.env['ComSpec'] ?? 'cmd.exe',
  args: ['/d', '/s', '/c', 'npx', ...NPX_ARGS],
});

export const claudeAgentCommand = (
  platform: NodeJS.Platform = process.platform,
): AgentCommand => {
  if (platform === 'win32') return npxThroughWindowsShell();
  return { command: 'npx', args: NPX_ARGS };
};

const recordAt = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const value = record[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...value };
};

export const claudeSessionMeta = (meta: SessionMeta = {}): SessionMeta => {
  const claudeCode = recordAt(meta, 'claudeCode');
  return {
    ...meta,
    claudeCode: {
      ...claudeCode,
      options: { ...recordAt(claudeCode, 'options'), ...CLAUDE_LOCKED_OPTIONS },
    },
  };
};

const lockPermissions = (client: AcpClient): AcpClient => ({
  ...client,
  newSession: async (setup) => {
    const response = await client.newSession({
      ...setup,
      meta: claudeSessionMeta(setup.meta),
    });
    await client.setSessionMode(response.sessionId, CLAUDE_DEFAULT_MODE_ID);
    return response;
  },
  resumeSession: async (setup) => {
    const resumed = await client.resumeSession({
      ...setup,
      meta: claudeSessionMeta(setup.meta),
    });
    await client.setSessionMode(resumed.sessionId, CLAUDE_DEFAULT_MODE_ID);
    return resumed;
  },
});

const refuseUnlockableSettings = async (
  launch: RuntimeLaunch,
  command: AgentCommand,
) => {
  const env = command.env ?? launch.env ?? process.env;
  const overrides = await findClaudeSettingsOverrides(launch.cwd, env);
  if (overrides.length > 0) throw new ClaudePermissionSettingsError(overrides);
};

const prepareLaunch = async (launch: RuntimeLaunch) => {
  if (launch.command) {
    await refuseUnlockableSettings(launch, launch.command);
    return;
  }
  await mkdir(claudeRuntimeDir(), { recursive: true });
};

const base = defineRuntimeAdapter({
  runtime: 'claude',
  displayName: 'Claude',
  command: (launch) => ({
    ...claudeAgentCommand(),
    cwd: claudeRuntimeDir(),
    env: {
      ...(launch.env ?? process.env),
      npm_config_registry: NPM_PUBLIC_REGISTRY,
    },
  }),
});

export const CLAUDE_ADAPTER: RuntimeAdapter = {
  ...base,
  connect: async (launch, options) => {
    await prepareLaunch(launch);
    const client = await base.connect(launch, {
      initializeTimeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS,
      ...options,
    });
    return lockPermissions(client);
  },
};
