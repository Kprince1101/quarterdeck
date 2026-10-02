import type { AuthMethod } from '@agentclientprotocol/sdk';

export const CLAUDE_LOGIN: AuthMethod = {
  type: 'terminal',
  id: 'claude-ai-login',
  name: 'Claude subscription',
  args: ['--cli', 'auth', 'login', '--claudeai'],
};

export const CLAUDE_CONSOLE_LOGIN: AuthMethod = {
  type: 'terminal',
  id: 'console-login',
  name: 'Anthropic Console',
  args: ['--cli', 'auth', 'login', '--console'],
};

export const CLAUDE_TERMINAL_COMMAND =
  'npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai';
