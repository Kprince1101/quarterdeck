import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCommand } from '@quarterdeck/server';

const TIMEOUT = { timeoutMs: 10_000 };

const node = (script: string) => ({
  command: process.execPath,
  args: ['-e', script],
});

describe('runCommand', () => {
  it('captures both streams and the exit code, even on failure', async () => {
    const result = await runCommand(
      node('console.log("out"); console.error("err"); process.exit(4)'),
      TIMEOUT,
    );
    expect(result).toEqual({
      status: 'exited',
      code: 4,
      signal: null,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('marks a command that is not on PATH as not found', async () => {
    const result = await runCommand(
      { command: `qd-missing-${randomUUID()}`, args: [] },
      TIMEOUT,
    );
    expect(result).toMatchObject({ status: 'failed', notFound: true });
  });

  it('kills a command that runs past its timeout', async () => {
    const result = await runCommand(node('setInterval(() => {}, 1000)'), {
      timeoutMs: 200,
    });
    expect(result).toEqual({
      status: 'failed',
      error: 'timed out',
      notFound: false,
    });
  });

  it('runs nothing once aborted', async () => {
    const result = await runCommand(node(''), {
      ...TIMEOUT,
      signal: AbortSignal.abort(),
    });
    expect(result).toEqual({
      status: 'failed',
      error: 'aborted',
      notFound: false,
    });
  });
});
