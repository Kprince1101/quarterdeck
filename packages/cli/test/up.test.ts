import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { quarterdeckHome } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE, main } from '../src/index.js';
import { entries, sandbox, testIo, type Sandbox } from './harness.js';

const TIMEOUT = 30_000;
const RUNNING = /^Quarterdeck is running at (http:\/\/127\.0\.0\.1:\d+)$/;

const runningUrl = async (lines: string[]): Promise<string> => {
  await vi.waitFor(() => expect(lines[0]).toMatch(RUNNING), {
    timeout: TIMEOUT,
  });
  return RUNNING.exec(lines[0] ?? '')?.[1] ?? '';
};

describe('quarterdeck up', { timeout: TIMEOUT }, () => {
  let box: Sandbox;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.close();
  });

  it('serves the dashboard and the API until it is stopped', async () => {
    const io = testIo(box.home);
    const exit = main(['up', '--port', '0'], io);
    const url = await runningUrl(io.lines);

    expect(io.lines.slice(1)).toEqual([
      `Data: ${quarterdeckHome(box.home)}`,
      'Press Ctrl+C to stop.',
    ]);
    expect(await entries(box.home)).toEqual(['.quarterdeck']);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const created = await fetch(`${url}/api/intents/project.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'deck', repoPath: box.repo }),
    });
    expect(created.status).toBe(200);

    io.stop();
    expect(await exit).toBe(0);
    expect(io.lines.at(-1)).toBe('Stopped.');
    await expect(fetch(`${url}/`)).rejects.toThrow();
  });

  it('says so when the port is taken', async () => {
    const taken = createServer();
    taken.listen(0, '127.0.0.1');
    await once(taken, 'listening');
    const { port } = taken.address() as AddressInfo;
    try {
      const io = testIo(box.home);
      expect(await main(['up', '--port', String(port)], io)).toBe(1);
      expect(io.errors).toEqual([
        `Port ${port} is already in use. Is Quarterdeck already running? Pass --port to pick another.`,
      ]);
    } finally {
      taken.close();
    }
  });

  it.each(['abc', '-1', '70000', '1.5'])('refuses --port %s', async (port) => {
    const io = testIo(box.home);
    expect(await main(['up', `--port=${port}`], io)).toBe(1);
    expect(io.errors).toEqual(['--port must be a number from 0 to 65535']);
  });
});

describe('quarterdeck', () => {
  it('prints usage for help and fails without a command', async () => {
    const help = testIo('/nowhere');
    expect(await main(['--help'], help)).toBe(0);
    expect(help.lines).toEqual([USAGE]);

    const none = testIo('/nowhere');
    expect(await main([], none)).toBe(1);
    expect(none.errors).toEqual([USAGE]);
  });

  it('names an unknown command', async () => {
    const io = testIo('/nowhere');
    expect(await main(['launch'], io)).toBe(1);
    expect(io.errors[0]).toContain('Unknown command launch');
  });

  it.each(['up', 'init', 'doctor'])('prints %s --help', async (command) => {
    const io = testIo('/nowhere');
    expect(await main([command, '--help'], io)).toBe(0);
    expect(io.lines[0]).toContain(`Usage: quarterdeck ${command}`);
  });
});
