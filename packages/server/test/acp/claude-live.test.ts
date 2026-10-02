import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  CLAUDE_ADAPTER,
  CLAUDE_AGENT_ACP_PACKAGE,
  CLAUDE_INITIALIZE_TIMEOUT_MS,
  CLAUDE_PERMISSION_SETTINGS,
  createClaudeAdapter,
  isAuthRequiredError,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  RuntimeAdapter,
} from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectAllExited } from './process-check.ts';

const claudeInstalled = (): boolean =>
  spawnSync('claude', ['--version'], {
    stdio: 'ignore',
    timeout: 10_000,
    shell: process.platform === 'win32',
  }).status === 0;

const LIVE = process.env['QUARTERDECK_LIVE'] === '1' && claudeInstalled();
const LIVE_TIMEOUT_MS = CLAUDE_INITIALIZE_TIMEOUT_MS + 240_000;
const PROBE_FILE = 'quarterdeck-permission-probe.txt';
const ALLOW_ALL_BASH = { permissions: { allow: ['Bash(*)'] } };

const rejectEverything = async (request: RequestPermissionRequest) => {
  const reject = request.options.find((option) =>
    option.kind.startsWith('reject'),
  );
  if (!reject) return { outcome: { outcome: 'cancelled' as const } };
  return {
    outcome: { outcome: 'selected' as const, optionId: reject.optionId },
  };
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

  const connect = async (
    adapter: RuntimeAdapter,
    events: AcpClientEvent[],
    permissionRequests: RequestPermissionRequest[],
  ) => {
    client = await adapter.connect(
      { cwd: dir },
      {
        clientName: 'quarterdeck-live-test',
        clientVersion: '0.0.0',
        onPermissionRequest: (request) => {
          permissionRequests.push(request);
          return rejectEverything(request);
        },
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'spawned') pids.push(event.pid);
        },
      },
    );
    return client;
  };

  const openSession = async (live: AcpClient, skip: (note: string) => void) => {
    try {
      const { sessionId } = await live.newSession({
        cwd: dir,
        mcpServers: [],
      });
      return sessionId;
    } catch (err) {
      if (isAuthRequiredError(err)) {
        skip('claude is installed but not signed in');
      }
      throw err;
    }
  };

  it(
    'answers a prompt over ACP',
    async ({ skip }) => {
      const events: AcpClientEvent[] = [];
      const live = await connect(CLAUDE_ADAPTER, events, []);
      expect(live.agent.agentInfo?.name).toBe(CLAUDE_AGENT_ACP_PACKAGE);

      const sessionId = await openSession(live, skip);
      const { stopReason } = await live.prompt(
        sessionId,
        'Reply with the single word pong and nothing else. Do not use any tools.',
      );

      expect(stopReason).toBe('end_turn');
      expect(agentText(events, sessionId).toLowerCase()).toContain('pong');
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'asks before a shell command that worktree settings allow, and honours the rejection',
    async ({ skip }) => {
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(
        join(dir, '.claude', 'settings.local.json'),
        JSON.stringify(ALLOW_ALL_BASH),
      );
      await expect(
        CLAUDE_ADAPTER.connect(
          { cwd: dir },
          {
            clientName: 'quarterdeck-live-test',
            clientVersion: '0.0.0',
            onPermissionRequest: rejectEverything,
          },
        ),
      ).rejects.toMatchObject({ code: CLAUDE_PERMISSION_SETTINGS });

      const permissionRequests: RequestPermissionRequest[] = [];
      const live = await connect(
        createClaudeAdapter({ refuseRepoAllowRules: false }),
        [],
        permissionRequests,
      );
      const sessionId = await openSession(live, skip);
      await live.prompt(
        sessionId,
        `Use your Bash tool to run exactly this command: touch ${PROBE_FILE}`,
      );

      expect(permissionRequests.length).toBeGreaterThan(0);
      expect(permissionRequests[0]?.sessionId).toBe(sessionId);
      expect(existsSync(join(dir, PROBE_FILE))).toBe(false);
    },
    LIVE_TIMEOUT_MS,
  );
});
