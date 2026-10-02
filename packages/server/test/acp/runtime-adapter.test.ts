import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANCELLED_PERMISSION,
  defineRuntimeAdapter,
  launchSite,
} from '@quarterdeck/server';
import type { AgentCommand, RuntimeLaunch } from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPORTER = `process.stderr.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.QD_MARKER ?? null }) + '\\n')`;
const reporter: AgentCommand = {
  command: process.execPath,
  args: ['-e', REPORTER],
};
const NOT_INSTALLED: AgentCommand = {
  command: 'quarterdeck-not-installed',
  args: [],
};

interface Report {
  cwd: string;
  marker: string | null;
}

const launchAndReport = async (
  launch: RuntimeLaunch,
  command: (launch: RuntimeLaunch) => AgentCommand,
): Promise<Report> => {
  const adapter = defineRuntimeAdapter({
    runtime: 'claude',
    displayName: 'Reporter',
    command,
  });
  const lines: string[] = [];
  await expect(
    adapter.connect(launch, {
      clientName: 'quarterdeck-test',
      clientVersion: '0.0.0',
      onPermissionRequest: async () => CANCELLED_PERMISSION,
      onEvent: (event) => {
        if (event.type === 'stderr') lines.push(event.line);
      },
    }),
  ).rejects.toThrow();
  const line = await vi.waitFor(() => {
    const [first] = lines;
    if (first === undefined) throw new Error('reporter printed nothing');
    return first;
  });
  return JSON.parse(line) as Report;
};

describe('defineRuntimeAdapter', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'qd-runtime-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts the runtime command where launchSite puts it', async () => {
    const report = await launchAndReport(
      { cwd: dir, env: { set: { QD_MARKER: 'from-launch' } } },
      (launch) => ({ ...reporter, ...launchSite(launch) }),
    );
    expect(report).toEqual({ cwd: dir, marker: 'from-launch' });
  });

  it('passes the launch to the runtime command builder', async () => {
    const seen: RuntimeLaunch[] = [];
    const launch: RuntimeLaunch = { cwd: dir, agentName: 'builder' };
    await launchAndReport(launch, (given) => {
      seen.push(given);
      return reporter;
    });
    expect(seen).toEqual([launch]);
  });

  it('runs a launch command override in the launch cwd with the launch env', async () => {
    const report = await launchAndReport(
      {
        cwd: dir,
        env: { set: { QD_MARKER: 'from-launch' } },
        command: reporter,
      },
      () => NOT_INSTALLED,
    );
    expect(report).toEqual({ cwd: dir, marker: 'from-launch' });
  });

  it('lets a launch command override carry its own cwd', async () => {
    const report = await launchAndReport(
      { cwd: tmpdir(), command: { ...reporter, cwd: dir } },
      () => NOT_INSTALLED,
    );
    expect(report.cwd).toBe(dir);
  });
});
