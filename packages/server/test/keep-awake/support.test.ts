import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKeepAwake,
  findTool,
  keepAwakeSupport,
} from '../../src/keep-awake/index.js';
import { MISSING, fakeSpawner } from './fake-hold.ts';

describe('keep-awake support', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qd-keep-awake-tools-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const install = async (name: string): Promise<string> => {
    const file = join(dir, name);
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    return file;
  };

  it('finds the platform tool on PATH', async () => {
    const file = await install('caffeinate');
    expect(
      await keepAwakeSupport({
        platform: 'darwin',
        env: { PATH: `/nowhere:${dir}` },
      }),
    ).toEqual({ available: true, tool: 'caffeinate', path: file });
  });

  it('says why when the tool is missing', async () => {
    expect(
      await keepAwakeSupport({ platform: 'linux', env: { PATH: dir } }),
    ).toEqual({
      available: false,
      tool: 'systemd-inhibit',
      reason:
        'systemd-inhibit is not on PATH, so Quarterdeck cannot keep this computer awake.',
    });
  });

  it('reports other platforms as unsupported', async () => {
    expect(await keepAwakeSupport({ platform: 'aix', env: {} })).toEqual({
      available: false,
      tool: null,
      reason: 'Keep-awake is not supported on aix.',
    });
  });

  it('skips files that are not executable', async () => {
    await writeFile(join(dir, 'systemd-inhibit'), '');
    expect(
      await findTool('systemd-inhibit', {
        platform: 'linux',
        env: { PATH: dir },
      }),
    ).toBeNull();
  });

  it('refuses to start without the tool and starts nothing', async () => {
    const fake = fakeSpawner();
    const keepAwake = createKeepAwake({
      home: dir,
      platform: 'linux',
      spawn: fake.spawn,
      support: MISSING('systemd-inhibit'),
    });
    expect(await keepAwake.read()).toEqual({
      on: false,
      mode: null,
      expiresAt: null,
      available: false,
      unavailableReason:
        'systemd-inhibit is not on PATH, so Quarterdeck cannot keep this computer awake.',
    });
    await expect(keepAwake.start({ minutes: 30 })).rejects.toThrow(
      'systemd-inhibit is not on PATH',
    );
    expect(fake.commands).toEqual([]);
    await keepAwake.close();
  });
});
