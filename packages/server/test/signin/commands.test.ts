import { describe, expect, it } from 'vitest';
import { signInCommand } from '../../src/signin/index.js';
import {
  CLAUDE_CONSOLE_LOGIN,
  CLAUDE_LOGIN,
  CLAUDE_TERMINAL_COMMAND,
} from './auth-methods.js';

describe('signInCommand', () => {
  it('falls back to each runtime CLI sign-in when no terminal method is advertised', () => {
    expect(signInCommand('kiro').command).toBe('kiro-cli login');
    expect(signInCommand('claude').command).toBe('claude auth login');
    expect(signInCommand('gemini').command).toBe('gemini');
    expect(
      signInCommand('claude', [{ id: 'agent-login', name: 'Agent login' }])
        .command,
    ).toBe('claude auth login');
  });

  it('runs the agent invocation with the first terminal method args', () => {
    const signIn = signInCommand('claude', [
      CLAUDE_LOGIN,
      CLAUDE_CONSOLE_LOGIN,
    ]);

    expect(signIn).toEqual({
      runtime: 'claude',
      displayName: 'Claude Code',
      command: CLAUDE_TERMINAL_COMMAND,
      steps: `Run \`${CLAUDE_TERMINAL_COMMAND}\` in a terminal and finish the sign-in.`,
      alternatives: [
        'npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --console',
      ],
    });
  });

  it('sets the method env and quotes words a shell would split', () => {
    const signIn = signInCommand('gemini', [
      {
        type: 'terminal',
        id: 'key',
        name: 'API key',
        args: ['--auth', 'api key'],
        env: { GEMINI_AUTH: "it's" },
      },
    ]);

    expect(signIn.command).toBe(
      `GEMINI_AUTH='it'\\''s' gemini --acp --auth 'api key'`,
    );
  });
});
