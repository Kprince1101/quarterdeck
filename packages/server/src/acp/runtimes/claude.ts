import type { AgentCommand } from '../client/types.js';
import { defineRuntimeAdapter, launchSite } from './adapter.js';
import type { RuntimeAdapter } from './adapter.js';

export const CLAUDE_AGENT_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
export const CLAUDE_AGENT_ACP_VERSION = '0.85.0';
export const CLAUDE_INITIALIZE_TIMEOUT_MS = 300_000;

const NPX_ARGS = [
  '--yes',
  `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`,
];

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

const base = defineRuntimeAdapter({
  runtime: 'claude',
  displayName: 'Claude',
  command: (launch) => ({ ...claudeAgentCommand(), ...launchSite(launch) }),
});

export const CLAUDE_ADAPTER: RuntimeAdapter = {
  ...base,
  connect: (launch, options) =>
    base.connect(launch, {
      initializeTimeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS,
      ...options,
    }),
};
