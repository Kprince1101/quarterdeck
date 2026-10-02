import { tmpdir } from 'node:os';
import {
  CANCELLED_PERMISSION,
  CLAUDE_ADAPTER,
  CLAUDE_AGENT_ACP_PACKAGE,
  CLAUDE_AGENT_ACP_VERSION,
  CLAUDE_INITIALIZE_TIMEOUT_MS,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  claudeAgentCommand,
} from '@quarterdeck/server';
import type { AgentCommand } from '@quarterdeck/server';
import { describe, expect, it } from 'vitest';
import { describeRuntimeConformance } from '../runtime-conformance.ts';

const PINNED = `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`;

const SILENT_AGENT: AgentCommand = {
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
};

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

  it('starts in the session cwd with the launch env', () => {
    const env = { PATH: '/usr/bin' };
    expect(CLAUDE_ADAPTER.command({ cwd: '/work/deck', env })).toEqual({
      ...claudeAgentCommand(),
      cwd: '/work/deck',
      env,
    });
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
        { cwd: tmpdir(), command: SILENT_AGENT },
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

  it('ignores the kiro agent name', () => {
    expect(
      CLAUDE_ADAPTER.command({ cwd: tmpdir(), agentName: 'builder' }).args,
    ).not.toContain('builder');
  });
});
