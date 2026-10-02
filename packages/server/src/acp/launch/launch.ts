import { setTimeout as wait } from 'node:timers/promises';
import { getErrorMessage } from '../../lib/errors.js';
import { createClientEvents } from '../client/connection.js';
import { AcpClientError } from '../client/errors.js';
import { spawnAcpClient } from '../client/spawn.js';
import type {
  AcpClient,
  AcpClientOptions,
  AgentCommand,
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
  const events = createClientEvents(options);
  events.emit(await probeAgentVersion(launch.version, versionTimeoutMs));

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
      await sleep(spawnRetryDelayMs, options.signal);
      if (options.signal?.aborted) throw err;
      return attempt(retry + 1);
    }
  };

  return attempt(1);
};
