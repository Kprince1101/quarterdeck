import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  defaultKiroAgentsDir,
  isAuthRequiredError,
  KIRO_ADAPTER,
  kiroAgentConfigPath,
  kiroAgentName,
} from '@quarterdeck/server';
import type { AcpClientEvent } from '@quarterdeck/server';
import { describe, expect, it, vi } from 'vitest';

const LIVE = process.env['QUARTERDECK_KIRO_LIVE'] === '1';
const LIVE_TIMEOUT_MS = 180_000;
const AGENT_NAME = 'smoke';
const REPLY = 'quarterdeck-kiro-smoke-ok';

const MCP_STUB = fileURLToPath(
  new URL('kiro-live/mcp-stub.ts', import.meta.url),
);

const rejectEverything = async (request: RequestPermissionRequest) => {
  const reject = request.options.find((option) =>
    option.kind.startsWith('reject'),
  );
  if (!reject) return { outcome: { outcome: 'cancelled' as const } };
  return {
    outcome: { outcome: 'selected' as const, optionId: reject.optionId },
  };
};

const agentText = (events: AcpClientEvent[]): string =>
  events
    .flatMap((event) => {
      if (event.type !== 'session_update') return [];
      const { update } = event;
      if (update.sessionUpdate !== 'agent_message_chunk') return [];
      if (update.content.type !== 'text') return [];
      return [update.content.text];
    })
    .join('');

describe.skipIf(!LIVE)('kiro live smoke (signed-in kiro-cli)', () => {
  it(
    'runs a turn through kiro-cli acp --agent with the bus MCP in the config',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'quarterdeck-kiro-live-'));
      const marker = join(workdir, 'bus-started');
      const events: AcpClientEvent[] = [];
      const client = await KIRO_ADAPTER.connect(
        {
          cwd: workdir,
          agentName: AGENT_NAME,
          mcpServers: [
            {
              name: 'bus',
              command: process.execPath,
              args: [
                '--experimental-strip-types',
                '--disable-warning=ExperimentalWarning',
                MCP_STUB,
              ],
              env: [{ name: 'QUARTERDECK_MCP_STUB_MARKER', value: marker }],
            },
          ],
        },
        {
          clientName: 'quarterdeck-kiro-live',
          clientVersion: '0.0.0',
          onPermissionRequest: rejectEverything,
          onEvent: (event) => events.push(event),
        },
      );
      const configPath = kiroAgentConfigPath(
        defaultKiroAgentsDir(),
        kiroAgentName(AGENT_NAME),
      );
      try {
        expect(existsSync(configPath)).toBe(true);
        const session = await client
          .newSession({ cwd: workdir, mcpServers: [] })
          .catch((err: unknown) => {
            if (isAuthRequiredError(err)) {
              throw new Error(
                'kiro-cli is not signed in. Run `kiro-cli login`, then rerun.',
                { cause: err },
              );
            }
            throw err;
          });
        const response = await client.prompt(
          session.sessionId,
          `Reply with exactly ${REPLY} and nothing else. Do not use any tools.`,
        );
        expect(response.stopReason).toBe('end_turn');
        expect(agentText(events)).toContain(REPLY);
        await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
          timeout: 30_000,
        });
      } finally {
        await client.close();
        rmSync(workdir, { recursive: true, force: true });
      }
      expect(existsSync(configPath)).toBe(false);
    },
    LIVE_TIMEOUT_MS,
  );
});
