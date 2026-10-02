import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { quarterdeckHome } from '../../../store/paths.js';
import type {
  AcpClient,
  AgentCommand,
  SessionMeta,
} from '../../client/types.js';
import { launchAcpClient } from '../../launch/launch.js';
import type { AgentLaunch, LaunchOptions } from '../../launch/launch.js';
import { launchSite } from '../adapter.js';
import type {
  RuntimeAdapter,
  RuntimeAdapterSpec,
  RuntimeLaunch,
} from '../adapter.js';
import {
  ClaudePermissionSettingsError,
  findClaudeSettingsOverrides,
  isRepoAllowOverride,
} from './settings.js';
import type { ClaudeSettingsOverride } from './settings.js';

export const CLAUDE_AGENT_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
export const CLAUDE_AGENT_ACP_VERSION = '0.85.0';
export const CLAUDE_INITIALIZE_TIMEOUT_MS = 300_000;
export const CLAUDE_DEFAULT_MODE_ID = 'default';
export const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

export const CLAUDE_LOCKED_OPTIONS = {
  settingSources: [],
  allowDangerouslySkipPermissions: false,
} as const;

const PINNED_PACKAGE = `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`;
const NPX_ARGS = ['--yes', PINNED_PACKAGE];
const VERSION_NPX_ARGS = [
  '--yes',
  '--offline',
  PINNED_PACKAGE,
  '--cli',
  '--version',
];

export const claudeRuntimeDir = (home: string = quarterdeckHome()): string =>
  join(home, 'runtimes', 'claude');

const npxCommand = (
  npxArgs: string[],
  platform: NodeJS.Platform,
): AgentCommand => {
  if (platform !== 'win32') return { command: 'npx', args: npxArgs };
  return {
    command: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', 'npx', ...npxArgs],
  };
};

export const claudeAgentCommand = (
  platform: NodeJS.Platform = process.platform,
): AgentCommand => npxCommand(NPX_ARGS, platform);

export const claudeVersionCommand = (
  platform: NodeJS.Platform = process.platform,
): AgentCommand => npxCommand(VERSION_NPX_ARGS, platform);

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

export interface ClaudeAdapterOptions {
  processDir?: string;
  refuseRepoAllowRules?: boolean;
}

export const createClaudeAdapter = ({
  processDir = claudeRuntimeDir(),
  refuseRepoAllowRules = true,
}: ClaudeAdapterOptions = {}): RuntimeAdapter => {
  const spec: RuntimeAdapterSpec = {
    runtime: 'claude',
    displayName: 'Claude',
    command: (launch: RuntimeLaunch) => ({
      ...claudeAgentCommand(),
      cwd: processDir,
      env: {
        ...(launch.env ?? process.env),
        npm_config_registry: NPM_PUBLIC_REGISTRY,
      },
    }),
  };

  const agentLaunch = (launch: RuntimeLaunch): AgentLaunch => {
    if (launch.command) {
      const command = { ...launchSite(launch), ...launch.command };
      return { command, version: { ...command, args: ['--version'] } };
    }
    const command = spec.command(launch);
    return { command, version: { ...command, ...claudeVersionCommand() } };
  };

  const refused = (
    launch: RuntimeLaunch,
    overrides: ClaudeSettingsOverride[],
  ): ClaudeSettingsOverride[] => {
    if (launch.command) return overrides;
    if (refuseRepoAllowRules) return overrides.filter(isRepoAllowOverride);
    return [];
  };

  const refuseUnlockedSettings = async (launch: RuntimeLaunch) => {
    const env = launch.command?.env ?? launch.env ?? process.env;
    const overrides = await findClaudeSettingsOverrides(launch.cwd, env);
    const blocking = refused(launch, overrides);
    if (blocking.length > 0) throw new ClaudePermissionSettingsError(blocking);
  };

  const connect = async (
    launch: RuntimeLaunch,
    options: LaunchOptions,
  ): Promise<AcpClient> => {
    await refuseUnlockedSettings(launch);
    await mkdir(processDir, { recursive: true });
    const client = await launchAcpClient(agentLaunch(launch), {
      initializeTimeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS,
      ...options,
    });
    return lockPermissions(client);
  };

  return { ...spec, connect };
};

export const CLAUDE_ADAPTER: RuntimeAdapter = createClaudeAdapter();
