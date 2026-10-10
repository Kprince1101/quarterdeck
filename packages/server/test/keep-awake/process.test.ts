import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LINUX_BACKEND,
  LINUX_INHIBIT_ARGS,
  createKeepAwake,
  keepAwakePath,
  spawnHoldProcess,
  writeKeepAwakeRecord,
  type HeldProcess,
  type HoldCommand,
  type HoldSpec,
} from '../../src/keep-awake/index.js';
import { expectAllExited, isAlive } from '../acp/process-check.ts';

const TIMEOUT = 30_000;

const IDLE_CHILD = {
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
};

const linuxHeldCommand = (hold: HoldSpec): HoldCommand => {
  const [command = '', ...args] = LINUX_BACKEND.command(hold).args.slice(
    LINUX_INHIBIT_ARGS.length,
  );
  return { command, args };
};

describe.skipIf(process.platform === 'win32')(
  'keep-awake child process',
  { timeout: TIMEOUT },
  () => {
    let home = '';
    const started: HeldProcess[] = [];

    const hold = async (): Promise<HeldProcess> => {
      const held = await spawnHoldProcess(IDLE_CHILD);
      started.push(held);
      return held;
    };

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'qd-keep-awake-process-'));
    });

    afterEach(async () => {
      await Promise.all(started.splice(0).map((held) => held.stop()));
      await rm(home, { recursive: true, force: true });
    });

    it('stops the real child and waits for it to exit', async () => {
      const held = await hold();
      expect(isAlive(held.pid)).toBe(true);
      await held.stop();
      expect(isAlive(held.pid)).toBe(false);
    });

    it('kills the real child at once when the server exits', async () => {
      const held = await hold();
      held.stopNow();
      await held.exited;
      await expectAllExited([held.pid]);
    });

    it('sweeps a hold a crashed server left behind, and starts off', async () => {
      const orphan = await hold();
      await writeKeepAwakeRecord(home, orphan);
      const keepAwake = createKeepAwake({ home });

      await keepAwake.recover();

      await expectAllExited([orphan.pid]);
      expect(existsSync(keepAwakePath(home))).toBe(false);
      expect(await keepAwake.read()).toMatchObject({ on: false, mode: null });
      await keepAwake.close();
    });

    it.runIf(process.platform === 'linux')(
      'ends the Linux hold when the server is killed outright',
      async () => {
        const server = await hold();
        const inhibited = await spawnHoldProcess(
          linuxHeldCommand({ seconds: null, ownerPid: server.pid }),
        );
        started.push(inhibited);
        expect(isAlive(inhibited.pid)).toBe(true);

        process.kill(server.pid, 'SIGKILL');

        await inhibited.exited;
        await expectAllExited([inhibited.pid]);
      },
    );

    it.runIf(process.platform === 'linux')(
      'ends a timed Linux hold on its own while the server lives',
      async () => {
        const server = await hold();
        const inhibited = await spawnHoldProcess(
          linuxHeldCommand({ seconds: 1, ownerPid: server.pid }),
        );
        started.push(inhibited);

        await inhibited.exited;
        expect(isAlive(server.pid)).toBe(true);
      },
    );

    it('leaves a process alone when the recorded pid was reused', async () => {
      const stranger = await hold();
      await writeKeepAwakeRecord(home, {
        pid: stranger.pid,
        startedAt: new Date(stranger.startedAt.getTime() - 3_600_000),
      });
      const keepAwake = createKeepAwake({ home });

      await keepAwake.recover();

      expect(isAlive(stranger.pid)).toBe(true);
      expect(existsSync(keepAwakePath(home))).toBe(false);
      await keepAwake.close();
    });
  },
);
