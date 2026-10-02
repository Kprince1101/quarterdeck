import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface EntryReport {
  agent: string;
  pid: number;
  events: string[];
}

const ROOT = resolve(import.meta.dirname, '../../..');
const STUB_AGENT = resolve(import.meta.dirname, 'acp/stub-agent.ts');
const ENTRY_SCRIPT = [
  "const { spawnAcpClient } = await import('@quarterdeck/server');",
  'const events = [];',
  'const client = await spawnAcpClient(',
  "  { command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', process.argv[1], 'resume', 'serve'] },",
  '  {',
  "    clientName: 'entry-check',",
  "    clientVersion: '0.0.0',",
  "    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),",
  '    onEvent: (event) => events.push(event),',
  '  },',
  ');',
  'await client.close();',
  "const spawned = events.find((event) => event.type === 'spawned');",
  'process.stdout.write(JSON.stringify({',
  '  agent: client.agent.agentInfo.name,',
  '  pid: spawned.pid,',
  "  events: events.map((event) => event.type).filter((type) => type !== 'stderr'),",
  '}));',
].join('\n');

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('@quarterdeck/server package entry', () => {
  it('drives an ACP agent from plain Node and stops it', () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', ENTRY_SCRIPT, STUB_AGENT],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as EntryReport;
    expect(report.agent).toBe('stub-agent');
    expect(report.events).toEqual(['spawned', 'closed', 'exit']);
    expect(isAlive(report.pid)).toBe(false);
  });
});
