import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
import { expectAllExited, markedProcesses } from './process-check.ts';

interface Run {
  events: AcpClientEvent[];
  waits: number[];
  options: LaunchOptions;
}

const FAKE_VERSION = 'fake-cli 1.2.3';
const WAIT = { timeout: 10_000 };
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

const versionEvents = (events: AcpClientEvent[]) =>
  events.filter((event) => event.type === 'agent_version');

const nodeScript = (script: string, ...args: string[]): AgentCommand => ({
  command: process.execPath,
  args: ['-e', script, ...args],
});

const readVersionFile = (file: string) =>
  nodeScript(
    "console.log(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
    file,
  );

const STUBBORN_SCRIPT = [
  "process.on('SIGTERM', () => {});",
  'setInterval(() => {}, 1000);',
].join(' ');

const stubbornVersion = (marker: string) => nodeScript(STUBBORN_SCRIPT, marker);

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

  it('starts the agent once its binary appears and logs its version', async () => {
    const dir = await tempDir();
    const command = {
      ...fakeAgentLaunch(),
      command: resolve(dir, 'agent'),
    };
    const versionFile = resolve(dir, 'version');
    await writeFile(versionFile, 'fake-cli 1.0.0');
    const run = createRun({}, async (count) => {
      if (count !== 2) return;
      await symlink(process.execPath, command.command);
      await writeFile(versionFile, 'fake-cli 2.0.0');
    });

    const client = await launchAcpClient(
      { command, version: readVersionFile(versionFile) },
      run.options,
    );
    openClients.push(client);

    expect(client.agent.agentInfo?.name).toBe(FAKE_AGENT_NAME);
    expect(retryAttempts(run.events)).toEqual([1, 2]);
    expect(eventTypes(run.events)).toEqual([
      'agent_version',
      'spawn_retry',
      'spawn_retry',
      'spawned',
      'agent_version',
    ]);
    expect(versionEvents(run.events)).toMatchObject([
      { stage: 'before_spawn', version: 'fake-cli 1.0.0' },
      { stage: 'after_spawn', version: 'fake-cli 2.0.0' },
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
    await vi.waitFor(
      () => expect(retryAttempts(run.events)).toEqual([1]),
      WAIT,
    );
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
  it('logs the CLI version before and after every launch', async () => {
    const run = createRun();

    await launch(fakeAgentLaunch(), run);
    await launch(fakeAgentLaunch(), run);

    const logged = (stage: string) => ({
      type: 'agent_version',
      stage,
      command: process.execPath,
      version: FAKE_VERSION,
    });
    expect(versionEvents(run.events)).toEqual([
      logged('before_spawn'),
      logged('after_spawn'),
      logged('before_spawn'),
      logged('after_spawn'),
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

  it('reports a probe that exits non-zero', async () => {
    const run = createRun();
    const version = nodeScript('process.exit(3)');

    const client = await launchAcpClient(
      { command: fakeAgentLaunch(), version },
      run.options,
    );
    openClients.push(client);

    expect(run.events[0]).toMatchObject({
      version: null,
      error: 'exited with 3',
    });
  });

  it('kills a probe that ignores SIGTERM and launches anyway', async () => {
    const timeoutMs = 300;
    const marker = `qd-version-${randomUUID()}`;
    const run = createRun({ versionTimeoutMs: timeoutMs });
    const started = performance.now();
    let spawnedAfter = Infinity;
    const record = run.options.onEvent;
    run.options.onEvent = (event) => {
      record?.(event);
      if (event.type === 'spawned') spawnedAfter = performance.now() - started;
    };

    const client = await launchAcpClient(
      { command: fakeAgentLaunch(), version: stubbornVersion(marker) },
      run.options,
    );
    openClients.push(client);

    expect(versionEvents(run.events)).toMatchObject([
      { stage: 'before_spawn', version: null, error: 'timed out' },
      { stage: 'after_spawn', version: null, error: 'timed out' },
    ]);
    expect(spawnedAfter).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(spawnedAfter).toBeLessThan(timeoutMs + 4_000);
    await vi.waitFor(() => expect(markedProcesses(marker)).toEqual([]), WAIT);
  }, 20_000);

  it('rejects promptly when the signal aborts during the probe', async () => {
    const marker = `qd-version-${randomUUID()}`;
    const controller = new AbortController();
    const run = createRun({ signal: controller.signal });

    const failure = launchAcpClient(
      { command: fakeAgentLaunch(), version: stubbornVersion(marker) },
      run.options,
    );
    await vi.waitFor(
      () => expect(markedProcesses(marker)).not.toEqual([]),
      WAIT,
    );
    const abortedAt = performance.now();
    controller.abort();

    await expect(failure).rejects.toMatchObject({ code: 'aborted' });
    expect(performance.now() - abortedAt).toBeLessThan(1_000);
    expect(versionEvents(run.events)).toMatchObject([
      { stage: 'before_spawn', version: null, error: 'aborted' },
    ]);
    expect(eventTypes(run.events)).not.toContain('spawned');
    await vi.waitFor(() => expect(markedProcesses(marker)).toEqual([]), WAIT);
  }, 20_000);

  it('closes the started agent when the signal aborts during the re-probe', async () => {
    const dir = await tempDir();
    const hangFlag = resolve(dir, 'hang');
    const probing = resolve(dir, 'probing');
    const controller = new AbortController();
    const run = createRun({ signal: controller.signal });
    const record = run.options.onEvent;
    run.options.onEvent = (event) => {
      record?.(event);
      if (event.type === 'spawned') writeFileSync(hangFlag, '');
    };
    const version = nodeScript(
      [
        "const fs = require('node:fs');",
        'const [hang, probing] = process.argv.slice(1);',
        'if (fs.existsSync(hang)) {',
        "  fs.writeFileSync(probing, '');",
        `  ${STUBBORN_SCRIPT}`,
        `} else console.log(${JSON.stringify(FAKE_VERSION)});`,
      ].join('\n'),
      hangFlag,
      probing,
    );

    const failure = launchAcpClient(
      { command: fakeAgentLaunch(), version },
      run.options,
    );
    await vi.waitFor(() => expect(existsSync(probing)).toBe(true), WAIT);
    controller.abort();

    await expect(failure).rejects.toMatchObject({ code: 'aborted' });
    expect(versionEvents(run.events)).toMatchObject([
      { stage: 'before_spawn', version: FAKE_VERSION },
      { stage: 'after_spawn', version: null, error: 'aborted' },
    ]);
    expect(eventTypes(run.events)).toContain('closed');
  }, 20_000);
});
