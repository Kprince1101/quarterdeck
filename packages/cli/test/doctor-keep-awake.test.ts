import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_AWAKE_CHECK,
  KEEP_AWAKE_OFF,
  checkKeepAwake,
  main,
} from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const IS_WINDOWS = process.platform === 'win32';

describe.skipIf(IS_WINDOWS)('quarterdeck doctor: keep-awake', () => {
  let box: Sandbox;
  let io: TestIo;
  let bin = '';

  const install = async (name: string) => {
    const path = join(bin, name);
    await writeFile(path, '#!/bin/sh\n');
    await chmod(path, 0o755);
  };

  const check = (platform: NodeJS.Platform) =>
    checkKeepAwake({ ...io, env: { PATH: bin } }, { platform });

  beforeEach(async () => {
    box = await sandbox();
    bin = join(box.home, 'bin');
    await mkdir(bin);
    io = testIo(box.home);
  });

  afterEach(async () => {
    await box.close();
  });

  it('reports caffeinate on macOS', async () => {
    await install('caffeinate');
    expect(await check('darwin')).toEqual({
      name: KEEP_AWAKE_CHECK,
      state:
        'caffeinate found; the dashboard can keep this computer from sleeping',
      fixes: [],
    });
  });

  it('reports systemd-inhibit on Linux', async () => {
    await install('systemd-inhibit');
    expect((await check('linux')).state).toBe(
      'systemd-inhibit found; the dashboard can keep this computer from sleeping',
    );
  });

  it('says the control is off when the tool is missing', async () => {
    expect(await check('linux')).toEqual({
      name: KEEP_AWAKE_CHECK,
      state: `systemd-inhibit is not on PATH, so Quarterdeck cannot keep this computer awake. ${KEEP_AWAKE_OFF}`,
      fixes: [],
    });
  });

  it('reports an unsupported platform instead of failing', async () => {
    expect((await check('freebsd')).state).toBe(
      `Keep-awake is not supported on freebsd. ${KEEP_AWAKE_OFF}`,
    );
  });

  it('prints the line with no command to run', async () => {
    await main(['doctor'], { ...io, env: { PATH: bin } });
    const at = io.lines.findIndex((line) =>
      line.startsWith(`${KEEP_AWAKE_CHECK}:`),
    );
    expect(io.lines[at]).toBe(
      `${KEEP_AWAKE_CHECK}: ${(await check(process.platform)).state}`,
    );
    expect(io.lines[at + 1]).not.toMatch(/^ {2}/);
  });
});
