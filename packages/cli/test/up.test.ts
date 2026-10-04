import { once } from 'node:events';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { quarterdeckHome, readApiToken } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE, main } from '../src/index.js';
import { entries, sandbox, testIo, type Sandbox } from './harness.js';

const TIMEOUT = 30_000;
const RUNNING =
  /^Quarterdeck is running at (http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]{43})$/;

const running = async (
  lines: string[],
): Promise<{ url: string; token: string }> => {
  await vi.waitFor(() => expect(lines[0]).toMatch(RUNNING), {
    timeout: TIMEOUT,
  });
  const [, url = '', token = ''] = RUNNING.exec(lines[0] ?? '') ?? [];
  return { url, token };
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
    const { url, token } = await running(io.lines);

    expect(io.lines.slice(1)).toEqual([
      `Data: ${quarterdeckHome(box.home)}`,
      'Press Ctrl+C to stop.',
    ]);
    expect(await entries(box.home)).toEqual(['.quarterdeck']);
    expect(await readApiToken(quarterdeckHome(box.home))).toBe(token);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).not.toContain(token);
    const create = (headers: Record<string, string>) =>
      fetch(`${url}/api/intents/project.create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ project: 'example', repoPath: box.repo }),
      });
    expect((await create({})).status).toBe(401);
    const created = await create({ authorization: `Bearer ${token}` });
    expect(created.status).toBe(200);

    io.stop();
    expect(await exit).toBe(0);
    expect(io.lines.at(-1)).toBe('Stopped.');
    await expect(fetch(`${url}/`)).rejects.toThrow();
    await expect(readApiToken(quarterdeckHome(box.home))).rejects.toThrow();
  });

  const homeMode = async (): Promise<number> =>
    (await stat(quarterdeckHome(box.home))).mode & 0o777;

  const upAndStop = async (): Promise<void> => {
    const io = testIo(box.home);
    const exit = main(['up', '--port', '0'], io);
    await running(io.lines);
    io.stop();
    expect(await exit).toBe(0);
  };

  it.skipIf(process.platform === 'win32')(
    'creates a fresh ~/.quarterdeck as 0700',
    async () => {
      await upAndStop();
      expect(await homeMode()).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing loose ~/.quarterdeck to 0700',
    async () => {
      await mkdir(quarterdeckHome(box.home));
      await chmod(quarterdeckHome(box.home), 0o755);
      await upAndStop();
      expect(await homeMode()).toBe(0o700);
    },
  );

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

  it.each(['up', 'init', 'doctor', 'replay', 'wipe'])(
    'prints %s --help',
    async (command) => {
      const io = testIo('/nowhere');
      expect(await main([command, '--help'], io)).toBe(0);
      expect(io.lines[0]).toContain(`Usage: npm run quarterdeck -- ${command}`);
    },
  );
});
