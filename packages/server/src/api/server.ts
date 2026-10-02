import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { quarterdeckHome } from '../store/index.js';
import type { ApiContext } from './context.js';
import { createProjectStores, type ProjectStores } from './project-stores.js';
import { localGuard } from './request.js';
import { handleRequest } from './routes.js';

export const API_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 4317;

export interface ApiServerOptions {
  port?: number;
  homeDir?: string;
  allowedOrigins?: string[];
  databaseUrl?: string | undefined;
}

export interface ApiServer {
  url: string;
  port: number;
  stores: ProjectStores;
  close: () => Promise<void>;
}

export const startApiServer = async (
  options: ApiServerOptions = {},
): Promise<ApiServer> => {
  const homeDir = options.homeDir ?? homedir();
  const stores = createProjectStores(
    quarterdeckHome(homeDir),
    options.databaseUrl,
  );
  const ctx: ApiContext = { stores, homeDir };
  let guard = localGuard(0);
  const server = createServer((req, res) => {
    void handleRequest(ctx, guard, req, res);
  });
  server.listen(options.port ?? DEFAULT_API_PORT, API_HOST);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  guard = localGuard(port, options.allowedOrigins);
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await stores.closeAll();
  };
  return { url: `http://${API_HOST}:${port}`, port, stores, close };
};
