import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ES_DISPLAY_REQUIRED,
  ES_SYSTEM_REQUIRED,
  KEEP_AWAKE_BACKENDS,
  LINUX_BACKEND,
  MACOS_BACKEND,
  WINDOWS_BACKEND,
  WINDOWS_EXECUTION_STATE,
  createKeepAwake,
  keepAwakePath,
  windowsKeepAwakeScript,
  type HoldCommand,
  type KeepAwake,
  type KeepAwakeBackend,
} from '../../src/keep-awake/index.js';
import { AVAILABLE, fakeSpawner, type FakeSpawner } from './fake-hold.ts';

const OWNER = 4242;
const HALF_HOUR_MS = 30 * 60 * 1000;

const decodePowerShell = (command: HoldCommand): string =>
  Buffer.from(command.args.at(-1) ?? '', 'base64').toString('utf16le');

interface Case {
  backend: KeepAwakeBackend;
  timed: HoldCommand;
  open: HoldCommand;
}

const powershell = (seconds: number | null): HoldCommand => ({
  command: 'powershell',
  args: [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(
      windowsKeepAwakeScript({ seconds, ownerPid: OWNER }),
      'utf16le',
    ).toString('base64'),
  ],
});

const CASES: Case[] = [
  {
    backend: MACOS_BACKEND,
    timed: {
      command: 'caffeinate',
      args: ['-i', '-t', '1800', '-w', String(OWNER)],
    },
    open: { command: 'caffeinate', args: ['-i', '-w', String(OWNER)] },
  },
  {
    backend: WINDOWS_BACKEND,
    timed: powershell(1800),
    open: powershell(null),
  },
  {
    backend: LINUX_BACKEND,
    timed: {
      command: 'systemd-inhibit',
      args: ['--what=idle', '--why=Quarterdeck', 'sleep', '1800'],
    },
    open: {
      command: 'systemd-inhibit',
      args: ['--what=idle', '--why=Quarterdeck', 'sleep', 'infinity'],
    },
  },
];

describe('keep-awake backends', () => {
  it('has one backend per supported platform', () => {
    expect(KEEP_AWAKE_BACKENDS).toEqual({
      darwin: MACOS_BACKEND,
      win32: WINDOWS_BACKEND,
      linux: LINUX_BACKEND,
    });
  });

  it('keeps the Mac from idle sleep, not the display, and dies with the server', () => {
    const { args } = MACOS_BACKEND.command({ seconds: 60, ownerPid: OWNER });
    expect(args).toContain('-i');
    expect(args).not.toContain('-d');
    expect(args.slice(-2)).toEqual(['-w', String(OWNER)]);
  });

  it('asks Windows for system, not display, and waits on the server', () => {
    expect(WINDOWS_EXECUTION_STATE).toBe(0x80000001);
    expect(WINDOWS_EXECUTION_STATE & ES_SYSTEM_REQUIRED).toBe(
      ES_SYSTEM_REQUIRED,
    );
    expect(WINDOWS_EXECUTION_STATE & ES_DISPLAY_REQUIRED).toBe(0);
    const timed = decodePowerShell(
      WINDOWS_BACKEND.command({ seconds: 1800, ownerPid: OWNER }),
    );
    expect(timed).toContain(
      `SetThreadExecutionState([uint32]${WINDOWS_EXECUTION_STATE})`,
    );
    expect(timed).toContain(
      `Wait-Process -Id ${OWNER} -Timeout 1800 -ErrorAction SilentlyContinue`,
    );
    const open = decodePowerShell(
      WINDOWS_BACKEND.command({ seconds: null, ownerPid: OWNER }),
    );
    expect(open).toContain(
      `Wait-Process -Id ${OWNER} -ErrorAction SilentlyContinue`,
    );
    expect(open).not.toContain('-Timeout');
  });

  it('inhibits only idle on Linux', () => {
    const { args } = LINUX_BACKEND.command({ seconds: 60, ownerPid: OWNER });
    expect(args.slice(0, 2)).toEqual(['--what=idle', '--why=Quarterdeck']);
  });
});

describe.each(CASES)(
  'keep-awake on $backend.platform',
  ({ backend, timed, open }) => {
    let home = '';
    let fake: FakeSpawner;
    let keepAwake: KeepAwake;

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      home = await mkdtemp(join(tmpdir(), 'qd-keep-awake-'));
      fake = fakeSpawner();
      keepAwake = createKeepAwake({
        home,
        platform: backend.platform,
        ownerPid: OWNER,
        spawn: fake.spawn,
        support: AVAILABLE(backend.tool),
      });
    });

    afterEach(async () => {
      await keepAwake.close();
      vi.useRealTimers();
      await rm(home, { recursive: true, force: true });
    });

    it('runs the exact command for a time limit and kills it on stop', async () => {
      const state = await keepAwake.start({ minutes: 30 });
      expect(fake.commands).toEqual([timed]);
      expect(state).toEqual({
        on: true,
        mode: 'duration',
        expiresAt: new Date(Date.now() + HALF_HOUR_MS).toISOString(),
        available: true,
        unavailableReason: null,
      });
      const [held] = fake.held;
      expect(JSON.parse(await readFile(keepAwakePath(home), 'utf8'))).toEqual({
        pid: held?.pid,
        startedAt: held?.startedAt.toISOString(),
      });

      expect(await keepAwake.stop()).toMatchObject({ on: false, mode: null });
      expect(held?.stop).toHaveBeenCalledTimes(1);
      expect(existsSync(keepAwakePath(home))).toBe(false);
    });

    it('runs the exact command with no limit until the voyage ends', async () => {
      const state = await keepAwake.start({ untilVoyageEnds: true });
      expect(fake.commands).toEqual([open]);
      expect(state).toMatchObject({
        on: true,
        mode: 'untilVoyageEnds',
        expiresAt: null,
      });
      await vi.advanceTimersByTimeAsync(24 * HALF_HOUR_MS);
      expect(fake.held[0]?.stop).not.toHaveBeenCalled();

      expect(await keepAwake.voyageEnded()).toMatchObject({ on: false });
      expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
    });

    it('kills the child when the time runs out', async () => {
      const heard: boolean[] = [];
      keepAwake.subscribe((state) => heard.push(state.on));
      await keepAwake.start({ minutes: 30 });
      await vi.advanceTimersByTimeAsync(HALF_HOUR_MS - 1);
      expect(fake.held[0]?.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(heard).toEqual([true, false]));
      expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
      expect(await keepAwake.read()).toMatchObject({ on: false });
      expect(existsSync(keepAwakePath(home))).toBe(false);
    });

    it('kills the child on shutdown and refuses to start after it', async () => {
      await keepAwake.start({ untilVoyageEnds: true });
      await keepAwake.close();
      expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
      expect(existsSync(keepAwakePath(home))).toBe(false);
      await expect(keepAwake.start({ minutes: 30 })).rejects.toThrow(
        'Quarterdeck is shutting down.',
      );
    });

    it('kills the child synchronously if the server process exits', async () => {
      const before = new Set(process.listeners('exit'));
      await keepAwake.start({ minutes: 30 });
      const added = process
        .listeners('exit')
        .filter((listener) => !before.has(listener));
      expect(added).toHaveLength(1);
      added[0]?.(0);
      expect(fake.held[0]?.stopNow).toHaveBeenCalledTimes(1);

      await keepAwake.stop();
      expect(process.listeners('exit')).not.toContain(added[0]);
    });

    it('replaces the current hold when started again', async () => {
      await keepAwake.start({ minutes: 30 });
      const state = await keepAwake.start({ untilVoyageEnds: true });
      expect(fake.commands).toEqual([timed, open]);
      expect(fake.held[0]?.stop).toHaveBeenCalledTimes(1);
      expect(fake.held[1]?.stop).not.toHaveBeenCalled();
      expect(state).toMatchObject({ on: true, mode: 'untilVoyageEnds' });

      await vi.advanceTimersByTimeAsync(HALF_HOUR_MS);
      expect(await keepAwake.read()).toMatchObject({ on: true });
    });

    it('ignores the voyage end for a time limit', async () => {
      await keepAwake.start({ minutes: 30 });
      expect(await keepAwake.voyageEnded()).toMatchObject({ on: true });
      expect(fake.held[0]?.stop).not.toHaveBeenCalled();
    });

    it('turns off when the child exits by itself', async () => {
      const heard: boolean[] = [];
      keepAwake.subscribe((state) => heard.push(state.on));
      await keepAwake.start({ minutes: 30 });
      fake.held[0]?.exit();
      await vi.waitFor(() => expect(heard).toEqual([true, false]));
      expect(existsSync(keepAwakePath(home))).toBe(false);
    });
  },
);
