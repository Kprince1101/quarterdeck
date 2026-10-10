import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { getErrorMessage } from '../../lib/errors.js';
import { childEnv } from '../env.js';
import { connectAcpClient, createClientEvents } from './connection.js';
import { AcpClientError } from './errors.js';
import type { EventHub } from './event-hub.js';
import { SPAWN_DETACHED, stopTree } from './process-tree.js';
import type {
  AcpClient,
  AcpClientEvent,
  AcpClientOptions,
  AgentCommand,
} from './types.js';

const spawnFailed = (command: string, reason: string) =>
  new AcpClientError(`Failed to start ${command}: ${reason}`, 'spawn_failed');

const startProcess = async ({ command, args, cwd, env }: AgentCommand) => {
  const child = spawn(command, args, {
    cwd: cwd ?? process.cwd(),
    env: childEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: SPAWN_DETACHED,
    windowsHide: true,
  });
  try {
    await once(child, 'spawn');
  } catch (err) {
    throw spawnFailed(command, getErrorMessage(err));
  }
  if (child.pid === undefined) throw spawnFailed(command, 'no pid');
  return { child, pid: child.pid };
};

const watchProcess = (
  child: ChildProcessWithoutNullStreams,
  events: EventHub<AcpClientEvent>,
) => {
  createInterface({ input: child.stderr })
    .on('line', (line) => {
      events.emit({ type: 'stderr', line });
    })
    .on('close', () => {
      events.emit({ type: 'stderr_closed' });
    });
  child.on('error', (err) => {
    events.emit({ type: 'process_error', message: getErrorMessage(err) });
  });
  child.stdin.on('error', (err) => {
    events.emit({ type: 'process_error', message: getErrorMessage(err) });
  });
  return new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      events.emit({ type: 'exit', code, signal });
      resolve();
    });
  });
};

export const DEFAULT_KILL_GRACE_MS = 5_000;

interface OpenClient {
  close: () => Promise<void>;
}

const openClients = new Set<OpenClient>();

export const openAcpClientCount = (): number => openClients.size;

export const closeAllAcpClients = async (): Promise<void> => {
  await Promise.allSettled([...openClients].map((open) => open.close()));
};

const terminate = async (
  pid: number,
  exited: Promise<void>,
  graceMs: number,
) => {
  await stopTree(pid, graceMs);
  await exited;
};

export const spawnAcpClient = async (
  command: AgentCommand,
  options: AcpClientOptions,
): Promise<AcpClient> => {
  const events = createClientEvents(options);
  const { child, pid } = await startProcess(command);
  const exited = watchProcess(child, events);
  events.emit({ type: 'spawned', pid });

  let stopping: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    stopping ??= terminate(
      pid,
      exited,
      options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    ).finally(() => openClients.delete(open));
    return stopping;
  };
  const open: OpenClient = { close: dispose };
  openClients.add(open);

  try {
    const client = await connectAcpClient({
      stream: ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
      options,
      events,
      dispose,
    });
    open.close = client.close;
    return client;
  } catch (err) {
    await dispose();
    throw err;
  }
};
