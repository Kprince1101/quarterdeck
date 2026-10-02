import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPAWN_RETRIES,
  DEFAULT_SPAWN_RETRY_DELAY_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
  launchAcpClient,
} from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  AgentCommand,
  LaunchOptions,
  Sleep,
} from '@quarterdeck/server';
import { FAKE_AGENT_NAME, fakeAgentLaunch } from './fake-agent/index.ts';
import { expectAllExited } from './process-check.ts';

interface Run {
  events: AcpClientEvent[];
  waits: number[];
  options: LaunchOptions;
}

const FAKE_VERSION = 'fake-cli 1.2.3';
const VERSION: AgentCommand = {
  command: process.execPath,
  args: ['-e', `console.log(${JSON.stringify(FAKE_VERSION)})`],
};

const openClients: AcpClient[] = [];
const tempDirs: string[] = [];
const spawnedPids: number[] = [];

const createRun = (
  overrides: Partial<LaunchOptions> = {},
  onWait: (count: number) => Promise<void> | void = () => {},
): Run => {
  const events: AcpClientEvent[] = [];
  const waits: number[] = [];
  const sleep: Sleep = async (ms) => {
    waits.push(ms);
    await onWait(waits.length);
  };
  const options: LaunchOptions = {
    clientName: 'quarterdeck-test',
    clientVersion: '0.0.0',
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    onEvent: (event) => {
      if (event.type === 'spawned') spawnedPids.push(event.pid);
      if (event.type !== 'stderr') events.push(event);
    },
    sleep,
    ...overrides,
  };
  return { events, waits, options };
};

const realSleep = (run: Run): Run => {
  delete run.options.sleep;
  return run;
};

const launch = async (command: AgentCommand, run: Run) => {
  const client = await launchAcpClient(
    { command, version: VERSION },
    run.options,
  );
  openClients.push(client);
  return client;
};

const tempDir = async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'quarterdeck-launch-'));
  tempDirs.push(dir);
  return dir;
};

const missingCommand = async (): Promise<AgentCommand> => ({
  command: resolve(await tempDir(), 'missing-agent'),
  args: [],
});

const eventTypes = (events: AcpClientEvent[]) =>
  events.map((event) => event.type);

const retryAttempts = (events: AcpClientEvent[]) =>
  events.flatMap((event) => {
    if (event.type !== 'spawn_retry') return [];
    return [event.attempt];
  });

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await expectAllExited(spawnedPids.splice(0));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('launch defaults', () => {
  it('retries three times, fifteen seconds apart', () => {
    expect(DEFAULT_SPAWN_RETRIES).toBe(3);
    expect(DEFAULT_SPAWN_RETRY_DELAY_MS).toBe(15_000);
    expect(DEFAULT_VERSION_TIMEOUT_MS).toBe(10_000);
  });
});

describe('spawn retry', () => {
  it('retries a command that cannot exec, then fails as spawn_failed', async () => {
    const run = createRun();
    const command = await missingCommand();

    const failure = launchAcpClient({ command, version: VERSION }, run.options);

    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(run.waits).toEqual([15_000, 15_000, 15_000]);
    expect(eventTypes(run.events)).toEqual([
      'agent_version',
      'spawn_retry',
      'spawn_retry',
      'spawn_retry',
    ]);
    expect(run.events[1]).toMatchObject({
      type: 'spawn_retry',
      attempt: 1,
      retries: 3,
      delayMs: 15_000,
      message: expect.stringContaining('ENOENT'),
    });
    expect(retryAttempts(run.events)).toEqual([1, 2, 3]);
  });

  it('starts the agent once its binary appears', async () => {
    const dir = await tempDir();
    const command = {
      ...fakeAgentLaunch(),
      command: resolve(dir, 'agent'),
    };
    const run = createRun({}, async (count) => {
      if (count === 2) await symlink(process.execPath, command.command);
    });

    const client = await launch(command, run);

    expect(client.agent.agentInfo?.name).toBe(FAKE_AGENT_NAME);
    expect(retryAttempts(run.events)).toEqual([1, 2]);
    expect(eventTypes(run.events)).toEqual([
      'agent_version',
      'spawn_retry',
      'spawn_retry',
      'spawned',
    ]);
  });

  it('honours custom retry count and delay', async () => {
    const run = createRun({ spawnRetries: 1, spawnRetryDelayMs: 50 });

    const failure = launchAcpClient(
      { command: await missingCommand(), version: VERSION },
      run.options,
    );

    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(run.waits).toEqual([50]);
    expect(retryAttempts(run.events)).toEqual([1]);
  });

  it('waits for real when no sleep is given', async () => {
    const run = realSleep(createRun({ spawnRetryDelayMs: 1 }));

    const failure = launchAcpClient(
      { command: await missingCommand(), version: VERSION },
      run.options,
    );

    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(retryAttempts(run.events)).toEqual([1, 2, 3]);
  });

  it('stops retrying when the signal aborts during a wait', async () => {
    const controller = new AbortController();
    const run = createRun({ signal: controller.signal }, () => {
      controller.abort();
    });

    const failure = launchAcpClient(
      { command: await missingCommand(), version: VERSION },
      run.options,
    );

    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(run.waits).toEqual([15_000]);
    expect(retryAttempts(run.events)).toEqual([1]);
  });

  it('cuts a real wait short when the signal aborts', async () => {
    const controller = new AbortController();
    const run = realSleep(createRun({ signal: controller.signal }));

    const failure = launchAcpClient(
      { command: await missingCommand(), version: VERSION },
      run.options,
    );
    await vi.waitFor(() => expect(retryAttempts(run.events)).toEqual([1]));
    controller.abort();

    await expect(failure).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(retryAttempts(run.events)).toEqual([1]);
  });

  it('does not retry an agent that started but failed to initialize', async () => {
    const run = createRun({ initializeTimeoutMs: 200 });

    const failure = launch(fakeAgentLaunch({ silent: true }), run);

    await expect(failure).rejects.toMatchObject({ code: 'initialize_timeout' });
    expect(run.waits).toEqual([]);
    expect(eventTypes(run.events)).not.toContain('spawn_retry');
  });
});

describe('agent version', () => {
  it('logs the CLI version before every launch', async () => {
    const run = createRun();

    await launch(fakeAgentLaunch(), run);
    await launch(fakeAgentLaunch(), run);

    const versions = run.events.filter(
      (event) => event.type === 'agent_version',
    );
    expect(versions).toEqual([
      {
        type: 'agent_version',
        command: process.execPath,
        version: FAKE_VERSION,
      },
      {
        type: 'agent_version',
        command: process.execPath,
        version: FAKE_VERSION,
      },
    ]);
    expect(eventTypes(run.events).slice(0, 2)).toEqual([
      'agent_version',
      'spawned',
    ]);
  });

  it('reads the version from stderr when stdout is empty', async () => {
    const run = createRun();
    const version = {
      command: process.execPath,
      args: ['-e', `console.error(${JSON.stringify(FAKE_VERSION)})`],
    };

    const client = await launchAcpClient(
      { command: fakeAgentLaunch(), version },
      run.options,
    );
    openClients.push(client);

    expect(run.events[0]).toMatchObject({ version: FAKE_VERSION });
  });

  it('launches anyway when the version probe fails', async () => {
    const run = createRun();
    const version = await missingCommand();

    const client = await launchAcpClient(
      { command: fakeAgentLaunch(), version },
      run.options,
    );
    openClients.push(client);

    expect(run.events[0]).toMatchObject({
      type: 'agent_version',
      command: version.command,
      version: null,
      error: expect.stringContaining('ENOENT'),
    });
    expect(eventTypes(run.events)).toContain('spawned');
  });

  it('reports a probe that prints nothing', async () => {
    const run = createRun();
    const version = { command: process.execPath, args: ['-e', ''] };

    const client = await launchAcpClient(
      { command: fakeAgentLaunch(), version },
      run.options,
    );
    openClients.push(client);

    expect(run.events[0]).toMatchObject({
      version: null,
      error: 'printed no version',
    });
  });

  it('gives up on a probe that hangs', async () => {
    const run = createRun({ versionTimeoutMs: 100 });
    const version = {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
    };

    const client = await launchAcpClient(
      { command: fakeAgentLaunch(), version },
      run.options,
    );
    openClients.push(client);

    expect(run.events[0]).toMatchObject({ version: null });
    expect(eventTypes(run.events)).toContain('spawned');
  });
});
