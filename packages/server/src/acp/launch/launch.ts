import { setTimeout as wait } from 'node:timers/promises';
import { getErrorMessage } from '../../lib/errors.js';
import { createClientEvents } from '../client/connection.js';
import { AcpClientError } from '../client/errors.js';
import { spawnAcpClient } from '../client/spawn.js';
import type {
  AcpClient,
  AcpClientOptions,
  AgentCommand,
  VersionStage,
} from '../client/types.js';
import { DEFAULT_VERSION_TIMEOUT_MS, probeAgentVersion } from './version.js';

export const DEFAULT_SPAWN_RETRIES = 3;
export const DEFAULT_SPAWN_RETRY_DELAY_MS = 15_000;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface AgentLaunch {
  command: AgentCommand;
  version: AgentCommand;
}

export interface LaunchOptions extends AcpClientOptions {
  spawnRetries?: number;
  spawnRetryDelayMs?: number;
  sleep?: Sleep;
  versionTimeoutMs?: number;
}

const sleepUntilAborted: Sleep = (ms, signal) =>
  wait(ms, undefined, { signal }).catch(() => {});

const isSpawnFailure = (err: unknown) =>
  err instanceof AcpClientError && err.code === 'spawn_failed';

const launchAborted = () =>
  new AcpClientError('ACP launch was aborted', 'aborted');

export const launchAcpClient = async (
  launch: AgentLaunch,
  options: LaunchOptions,
): Promise<AcpClient> => {
  const {
    spawnRetries = DEFAULT_SPAWN_RETRIES,
    spawnRetryDelayMs = DEFAULT_SPAWN_RETRY_DELAY_MS,
    sleep = sleepUntilAborted,
    versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  } = options;
  const { signal } = options;
  const events = createClientEvents(options);

  const logVersion = async (stage: VersionStage) => {
    const probe = await probeAgentVersion(launch.version, {
      timeoutMs: versionTimeoutMs,
      signal,
    });
    events.emit({
      type: 'agent_version',
      stage,
      command: launch.version.command,
      ...probe,
    });
  };

  const attempt = async (retry: number): Promise<AcpClient> => {
    try {
      return await spawnAcpClient(launch.command, options);
    } catch (err) {
      if (!isSpawnFailure(err) || retry > spawnRetries) throw err;
      events.emit({
        type: 'spawn_retry',
        attempt: retry,
        retries: spawnRetries,
        delayMs: spawnRetryDelayMs,
        message: getErrorMessage(err),
      });
      await sleep(spawnRetryDelayMs, signal);
      if (signal?.aborted) throw err;
      return attempt(retry + 1);
    }
  };

  await logVersion('before_spawn');
  if (signal?.aborted) throw launchAborted();
  const client = await attempt(1);
  await logVersion('after_spawn');
  if (signal?.aborted) {
    await client.close();
    throw launchAborted();
  }
  return client;
};
