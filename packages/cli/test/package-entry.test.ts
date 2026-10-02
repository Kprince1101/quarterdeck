import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CliManifest {
  bin: Record<string, string>;
}

const ROOT = resolve(import.meta.dirname, '..');
const TIMEOUT = 30_000;
const RUNNING = /Quarterdeck is running at (http:\/\/127\.0\.0\.1:\d+)/;

const binPath = async (): Promise<string> => {
  const manifest = JSON.parse(
    await readFile(join(ROOT, 'package.json'), 'utf8'),
  ) as CliManifest;
  return join(ROOT, manifest.bin['quarterdeck'] ?? '');
};

describe('quarterdeck bin', { timeout: TIMEOUT }, () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-cli-bin-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('runs from plain Node and prints usage', async () => {
    const result = spawnSync(process.execPath, [await binPath(), '--help'], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: quarterdeck <command>');
  });

  it('inits a repo without a terminal, writing nothing into it', async () => {
    const repo = join(home, 'deck');
    await mkdir(join(repo, '.git'), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [await binPath(), 'init', repo],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, DATABASE_URL: '' },
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Created project deck (deck) for ${repo}`);
  });

  it('starts with up, prints the URL and stops cleanly on SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [await binPath(), 'up', '--port', '0'],
      {
        env: { ...process.env, HOME: home, DATABASE_URL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(() => expect(stdout).toMatch(RUNNING), {
        timeout: TIMEOUT,
      });
      const url = RUNNING.exec(stdout)?.[1] ?? '';
      expect((await fetch(`${url}/`)).status).toBe(200);
      child.kill('SIGTERM');
      const [code] = await exited;
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toContain('Stopped.');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
