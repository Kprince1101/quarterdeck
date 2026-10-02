import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTENT_NAMES } from '../src/intents/index.js';
import { FAKE_AGENT_NAME, fakeAgentLaunch } from './acp/fake-agent/index.ts';
import { isAlive } from './acp/process-check.ts';
import { SHIPPED_MIGRATIONS } from './store/backends.js';

interface EntryReport {
  migrated: string[];
  kind: string;
  agent: string;
  pid: number;
  events: string[];
}

const ROOT = resolve(import.meta.dirname, '../../..');
const TIMEOUT = 30_000;
const ENTRY_SCRIPT = [
  "const { openStore, spawnAcpClient } = await import('@quarterdeck/server');",
  'const [home, launch] = process.argv.slice(1);',
  "const store = await openStore({ project: 'deck', home });",
  "const published = await store.publish({ kind: 'entry' });",
  'await store.close();',
  'const events = [];',
  'const client = await spawnAcpClient(JSON.parse(launch), {',
  "  clientName: 'entry-check',",
  "  clientVersion: '0.0.0',",
  "  onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),",
  '  onEvent: (event) => events.push(event),',
  '});',
  'await client.close();',
  "const spawned = events.find((event) => event.type === 'spawned');",
  'process.stdout.write(JSON.stringify({',
  '  migrated: store.migrated,',
  '  kind: published.kind,',
  '  agent: client.agent.agentInfo.name,',
  '  pid: spawned.pid,',
  "  events: events.map((event) => event.type).filter((type) => type !== 'stderr'),",
  '}));',
].join('\n');
const SCHEMA_SCRIPT = [
  "const schema = await import('@quarterdeck/server/stream-schema');",
  'const message = schema.streamMessageSchema.parse({',
  "  type: 'event',",
  '  event: {',
  '    id: 1,',
  "    projectId: '00000000-0000-4000-8000-000000000000',",
  '    agentId: null,',
  '    ticketId: null,',
  "    kind: 'entry',",
  '    payload: {},',
  "    createdAt: '2026-10-01T00:00:00.000Z',",
  '  },',
  '});',
  'process.stdout.write(JSON.stringify({ path: schema.STREAM_PATH, type: message.type }));',
].join('\n');

describe('@quarterdeck/server package entry', () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(resolve(tmpdir(), 'quarterdeck-server-entry-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it(
    'opens a migrated store and drives an ACP agent from plain Node',
    () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          ENTRY_SCRIPT,
          home,
          JSON.stringify(fakeAgentLaunch()),
        ],
        { cwd: ROOT, encoding: 'utf8' },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as EntryReport;
      expect(report).toMatchObject({
        migrated: SHIPPED_MIGRATIONS,
        kind: 'entry',
        agent: FAKE_AGENT_NAME,
        events: ['spawned', 'closed', 'exit'],
      });
      expect(isAlive(report.pid)).toBe(false);
    },
    TIMEOUT,
  );

  it('exposes the intent schemas and the API server from plain Node', () => {
    const script = [
      "const { INTENT_NAMES } = await import('@quarterdeck/server/intents');",
      "const { startApiServer } = await import('@quarterdeck/server');",
      'process.stdout.write(JSON.stringify({ count: INTENT_NAMES.length, start: typeof startApiServer }));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      count: INTENT_NAMES.length,
      start: 'function',
    });
  });

  it(
    'exposes the stream schema on its own subpath',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', SCHEMA_SCRIPT],
        { cwd: ROOT, encoding: 'utf8' },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        path: '/ws',
        type: 'event',
      });
    },
    TIMEOUT,
  );
});
