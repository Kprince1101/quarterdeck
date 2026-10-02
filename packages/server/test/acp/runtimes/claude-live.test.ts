import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANCELLED_PERMISSION,
  CLAUDE_ADAPTER,
  CLAUDE_INITIALIZE_TIMEOUT_MS,
  isAuthRequiredError,
} from '@quarterdeck/server';
import type { AcpClient } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectAllExited } from '../process-check.ts';

const claudeInstalled = (): boolean =>
  spawnSync('claude', ['--version'], {
    stdio: 'ignore',
    timeout: 10_000,
    shell: process.platform === 'win32',
  }).status === 0;

const LIVE = process.env['QUARTERDECK_LIVE'] === '1' && claudeInstalled();

const LIVE_TIMEOUT_MS = CLAUDE_INITIALIZE_TIMEOUT_MS + 120_000;

describe.skipIf(!LIVE)('claude runtime, live', () => {
  let dir = '';
  let client: AcpClient | undefined;
  const pids: number[] = [];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'qd-claude-live-')));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await expectAllExited(pids.splice(0));
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'answers a prompt over ACP',
    async (ctx) => {
      const chunks: string[] = [];
      client = await CLAUDE_ADAPTER.connect(
        { cwd: dir },
        {
          clientName: 'quarterdeck-live-test',
          clientVersion: '0.0.0',
          onPermissionRequest: async () => CANCELLED_PERMISSION,
          onEvent: (event) => {
            if (event.type === 'spawned') pids.push(event.pid);
            if (
              event.type === 'session_update' &&
              event.update.sessionUpdate === 'agent_message_chunk' &&
              event.update.content.type === 'text'
            ) {
              chunks.push(event.update.content.text);
            }
          },
        },
      );
      expect(client.agent.agentInfo?.name).toBe(
        '@agentclientprotocol/claude-agent-acp',
      );

      try {
        const { sessionId } = await client.newSession({
          cwd: dir,
          mcpServers: [],
        });
        const { stopReason } = await client.prompt(
          sessionId,
          'Reply with the single word pong and nothing else. Do not use any tools.',
        );
        expect(stopReason).toBe('end_turn');
      } catch (err) {
        if (isAuthRequiredError(err)) {
          ctx.skip('claude is installed but not signed in');
        }
        throw err;
      }
      expect(chunks.join('').toLowerCase()).toContain('pong');
    },
    LIVE_TIMEOUT_MS,
  );
});
