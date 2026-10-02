import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentNotFoundError } from '../agents/agent.js';
import { projectDataDir } from '../store/index.js';
import { loadBusTools } from './registry.js';
import { BUS_SERVER_NAME, createBusServer } from './server.js';
import type { BusStore, BusTool } from './tool.js';

export const BUS_SOCKET_ENV = 'QUARTERDECK_BUS_SOCKET';
export const BUS_TOKEN_ENV = 'QUARTERDECK_BUS_TOKEN';

export const BUS_RELAY = fileURLToPath(
  new URL(`relay${extname(import.meta.url)}`, import.meta.url),
);

const HANDSHAKE_MAX = 256;

export interface BusHostOptions {
  store: BusStore;
  socketPath: string;
  tools?: readonly BusTool[];
}

export interface BusHost {
  socketPath: string;
  tools: readonly BusTool[];
  launch: (agentId: string) => Promise<McpServerStdio>;
  revoke: (agentId: string) => void;
  close: () => Promise<void>;
}

interface Handshake {
  line: string;
  rest: Buffer;
}

export const busSocketPath = (project: string, home?: string): string => {
  const dir = dirname(projectDataDir(project, home));
  if (process.platform !== 'win32') return join(dir, 'bus.sock');
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\quarterdeck-${project}-${hash}`;
};

const readHandshake = (socket: Socket): Promise<Handshake> =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\n');
      if (end < 0 && buffered.length <= HANDSHAKE_MAX) return;
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.pause();
      if (end < 0) reject(new Error('bus handshake too long'));
      else
        resolve({
          line: buffered.subarray(0, end).toString('utf8'),
          rest: buffered.subarray(end + 1),
        });
    };
    const onClose = (): void => {
      socket.off('data', onData);
      reject(new Error('bus connection closed before its handshake'));
    };
    socket.on('data', onData);
    socket.once('close', onClose);
  });

const listen = async (
  server: ReturnType<typeof createServer>,
  socketPath: string,
): Promise<void> => {
  if (process.platform !== 'win32') {
    await mkdir(dirname(socketPath), { recursive: true });
    await rm(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
};

export const startBusHost = async (
  options: BusHostOptions,
): Promise<BusHost> => {
  const { store, socketPath } = options;
  const tools = options.tools ?? (await loadBusTools());
  const tokens = new Map<string, string>();
  const sockets = new Map<Socket, string | undefined>();

  const serve = async (
    socket: Socket,
    agentId: string,
    rest: Buffer,
  ): Promise<void> => {
    sockets.set(socket, agentId);
    if (rest.length > 0) socket.unshift(rest);
    const server = createBusServer({ store, agentId }, tools);
    socket.once('close', () => void server.close());
    socket.write('ok\n');
    await server.connect(new StdioServerTransport(socket, socket));
    socket.resume();
  };

  const accept = (socket: Socket): void => {
    sockets.set(socket, undefined);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    readHandshake(socket)
      .then(({ line, rest }) => {
        const agentId = tokens.get(line);
        if (agentId === undefined) {
          socket.end('denied\n');
          return undefined;
        }
        return serve(socket, agentId, rest);
      })
      .catch(() => socket.destroy());
  };

  const listener = createServer(accept);
  await listen(listener, socketPath);

  const tokenFor = (agentId: string): string => {
    for (const [token, owner] of tokens) if (owner === agentId) return token;
    const token = randomBytes(32).toString('hex');
    tokens.set(token, agentId);
    return token;
  };

  const launch = async (agentId: string): Promise<McpServerStdio> => {
    const { rows } = await store.db.query<{ id: string }>(
      `select id from agents
       where id = $1 and project_id = $2 and status <> 'retired'`,
      [agentId, store.projectId],
    );
    if (rows.length === 0) throw new AgentNotFoundError(agentId);
    return {
      name: BUS_SERVER_NAME,
      command: process.execPath,
      args: [BUS_RELAY],
      env: [
        { name: BUS_SOCKET_ENV, value: socketPath },
        { name: BUS_TOKEN_ENV, value: tokenFor(agentId) },
      ],
    };
  };

  const revoke = (agentId: string): void => {
    for (const [token, owner] of tokens)
      if (owner === agentId) tokens.delete(token);
    for (const [socket, owner] of sockets)
      if (owner === agentId) socket.destroy();
  };

  const shutdown = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
      listener.close(() => resolve());
    });
    tokens.clear();
    for (const socket of sockets.keys()) socket.destroy();
    await closed;
    if (process.platform !== 'win32') await rm(socketPath, { force: true });
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= shutdown();
    return closing;
  };

  return { socketPath, tools, launch, revoke, close };
};
