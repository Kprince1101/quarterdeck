import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { getErrorMessage } from '../../lib/errors.js';
import { connectAcpClient, createClientEvents } from './connection.js';
import { AcpClientError } from './errors.js';
import type { EventHub } from './event-hub.js';
import type {
  AcpClient,
  AcpClientEvent,
  AcpClientOptions,
  AgentCommand,
} from './types.js';

const startProcess = async ({ command, args, cwd, env }: AgentCommand) => {
  const child = spawn(command, args, {
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await once(child, 'spawn');
  } catch (err) {
    throw new AcpClientError(
      `Failed to start ${command}: ${getErrorMessage(err)}`,
      'spawn_failed',
    );
  }
  return child;
};

const watchProcess = (
  child: ChildProcessWithoutNullStreams,
  events: EventHub<AcpClientEvent>,
) => {
  createInterface({ input: child.stderr }).on('line', (line) => {
    events.emit({ type: 'stderr', line });
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

const isRunning = (child: ChildProcessWithoutNullStreams) =>
  child.exitCode === null && child.signalCode === null;

export const spawnAcpClient = async (
  command: AgentCommand,
  options: AcpClientOptions,
): Promise<AcpClient> => {
  const events = createClientEvents(options);
  const child = await startProcess(command);
  const exited = watchProcess(child, events);

  const dispose = async () => {
    if (isRunning(child)) child.kill('SIGTERM');
    await exited;
  };

  return connectAcpClient({
    stream: ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    ),
    options,
    events,
    dispose,
  });
};
