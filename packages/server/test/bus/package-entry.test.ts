import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TIMEOUT } from './fixtures.ts';

interface EntryReport {
  relay: string;
  tools: string[];
  status: string;
}

const ROOT = resolve(import.meta.dirname, '../../../..');
const ENTRY_SCRIPT = [
  "const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');",
  "const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');",
  "const { IN_MEMORY, openStore, startBusHost } = await import('@quarterdeck/server');",
  'const [dir] = process.argv.slice(1);',
  "const store = await openStore({ project: 'deck', dataDir: IN_MEMORY });",
  'const { rows } = await store.db.query(',
  "  `insert into agents (project_id, name, role) values ($1, 'okapi', 'builder') returning id`,",
  '  [store.projectId],',
  ');',
  "const host = await startBusHost({ store, socketPath: dir + '/bus.sock' });",
  'const launch = await host.launch(rows[0].id);',
  'const env = Object.fromEntries(launch.env.map(({ name, value }) => [name, value]));',
  'const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env });',
  "const client = new Client({ name: 'entry', version: '0.0.0' });",
  'await client.connect(transport);',
  "const reply = await client.callTool({ name: 'status', arguments: { text: 'built' } });",
  'await client.close();',
  'await host.close();',
  'await store.close();',
  'process.stdout.write(JSON.stringify({',
  '  relay: launch.args[0],',
  '  tools: host.tools.map((tool) => tool.name),',
  '  status: reply.content[0].text,',
  '}));',
].join('\n');

describe('bus from the built package', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qd-bus-entry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'loads its tools from dist and relays a session through dist/bus/relay.js',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', ENTRY_SCRIPT, dir],
        { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as EntryReport;
      expect(report).toEqual({
        relay: resolve(ROOT, 'packages/server/dist/bus/relay.js'),
        tools: ['read', 'report', 'status', 'verdict'],
        status: 'noted',
      });
    },
    TIMEOUT,
  );
});
