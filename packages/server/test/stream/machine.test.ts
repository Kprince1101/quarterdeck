import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalPausePath, setGlobalPause } from '../../src/pause/index.js';
import {
  MACHINE_EVENT_KINDS,
  readMachineState,
} from '../../src/stream/index.js';

describe('machine state', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-machine-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is unpaused without pause.json, even before the data folder exists', async () => {
    expect(await readMachineState(home)).toEqual({ pausedAt: null });
    expect(await readMachineState(join(home, 'missing'))).toEqual({
      pausedAt: null,
    });
  });

  it('reads pausedAt from pause.json as pause.all writes it', async () => {
    await setGlobalPause(home, true);
    const { pausedAt } = await readMachineState(home);
    expect(pausedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);

    await setGlobalPause(home, false);
    expect(await readMachineState(home)).toEqual({ pausedAt: null });
  });

  it('falls back to the file time for a pause.json it cannot read', async () => {
    await writeFile(globalPausePath(home), 'paused by hand\n');
    const { mtime } = await stat(globalPausePath(home));
    expect(await readMachineState(home)).toEqual({
      pausedAt: mtime.toISOString(),
    });

    await rm(globalPausePath(home));
    await mkdir(globalPausePath(home));
    expect((await readMachineState(home)).pausedAt).not.toBeNull();
  });

  it('refreshes on pause.all only', () => {
    expect([...MACHINE_EVENT_KINDS]).toEqual(['pause.all']);
  });
});
