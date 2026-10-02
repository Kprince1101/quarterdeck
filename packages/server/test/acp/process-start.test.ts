import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROCESS_START_TOLERANCE_MS,
  closeAllAcpClients,
  openAcpClientCount,
  parseProcessStart,
  processStartedAt,
  spawnAcpClient,
  stopOwnTree,
  stopTree,
  type AcpClientEvent,
} from '../../src/acp/client/index.js';
import {
  GRACE_MS,
  IS_WINDOWS,
  TIMEOUT,
  exitOf,
  isRunning,
  startSleeper,
  stopSleepers,
} from '../lifecycle/fixtures.js';
import { fakeAgentLaunch } from './fake-agent/index.ts';
import { expectAllExited } from './process-check.ts';

const DEAD_PID = 2 ** 22 + 12_345;

afterEach(() => {
  stopSleepers();
});

describe('parseProcessStart', () => {
  it('reads the ps lstart format as local time', () => {
    expect(parseProcessStart('Wed Oct  1 09:05:07 2026\n')).toEqual(
      new Date(2026, 9, 1, 9, 5, 7),
    );
    expect(parseProcessStart('Sat Dec 31 23:59:59 2022')).toEqual(
      new Date(2022, 11, 31, 23, 59, 59),
    );
  });

  it.each(['', 'yesterday', 'Wed Foo  1 09:05:07 2026', '2026-10-01T09:05'])(
    'refuses %j',
    (text) => {
      expect(parseProcessStart(text)).toBeNull();
    },
  );
});

describe.skipIf(IS_WINDOWS)('process ownership', { timeout: TIMEOUT }, () => {
  it('reads when a running process started, and null for no process', async () => {
    const sleeper = await startSleeper();
    const started = await processStartedAt(sleeper.pid);
    expect(started).not.toBeNull();
    expect(
      Math.abs((started?.getTime() ?? 0) - sleeper.startedAt.getTime()),
    ).toBeLessThanOrEqual(PROCESS_START_TOLERANCE_MS);
    expect(await processStartedAt(DEAD_PID)).toBeNull();
  });

  it('terminates its own group with SIGTERM', async () => {
    const sleeper = await startSleeper();
    expect(await stopOwnTree(sleeper, GRACE_MS)).toBe('terminated');
    expect(await exitOf(sleeper)).toEqual([null, 'SIGTERM']);
  });

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const sleeper = await startSleeper({ ignoreSigterm: true });
    expect(await stopOwnTree(sleeper, GRACE_MS)).toBe('killed');
    expect(await exitOf(sleeper)).toEqual([null, 'SIGKILL']);
  });

  it('leaves a process alone when its start time is not the recorded one', async () => {
    const sleeper = await startSleeper();
    const reused = {
      pid: sleeper.pid,
      startedAt: new Date(sleeper.startedAt.getTime() - 60_000),
    };
    expect(await stopOwnTree(reused, GRACE_MS)).toBe('gone');
    expect(isRunning(sleeper.pid)).toBe(true);
  });

  it('reports a group that is already gone', async () => {
    const sleeper = await startSleeper();
    expect(await stopTree(sleeper.pid, GRACE_MS)).toBe('terminated');
    await exitOf(sleeper);
    expect(await stopOwnTree(sleeper, GRACE_MS)).toBe('gone');
    expect(await stopTree(sleeper.pid, GRACE_MS)).toBe('gone');
  });
});

describe('closeAllAcpClients', { timeout: TIMEOUT }, () => {
  it('closes every spawned client and stops its process', async () => {
    const events: AcpClientEvent[] = [];
    const options = {
      clientName: 'quarterdeck-test',
      clientVersion: '0.0.0',
      onPermissionRequest: async () => ({
        outcome: { outcome: 'cancelled' as const },
      }),
      onEvent: (event: AcpClientEvent) => events.push(event),
      killGraceMs: GRACE_MS,
    };
    const before = openAcpClientCount();
    const clients = await Promise.all([
      spawnAcpClient(fakeAgentLaunch(), options),
      spawnAcpClient(fakeAgentLaunch({ ignoreSigterm: true }), options),
    ]);
    expect(openAcpClientCount()).toBe(before + 2);
    const pids = events.flatMap((event) => {
      if (event.type !== 'spawned') return [];
      return [event.pid];
    });

    await closeAllAcpClients();

    expect(openAcpClientCount()).toBe(before);
    await expectAllExited(pids);
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'closed')).toHaveLength(2),
    );
    await Promise.all(clients.map((client) => client.close()));
  });
});
