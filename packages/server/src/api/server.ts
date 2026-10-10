import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { closeAllAcpClients } from '../acp/client/index.js';
import {
  createGlobalLayouts,
  type GlobalLayouts,
} from '../global-layout/index.js';
import type { KeepAwake } from '../keep-awake/control.js';
import type { StopHosts } from '../lifecycle/stop.js';
import type { SetupProbe } from '../setup/probe.js';
import {
  createSetupSignIns,
  type SetupSignInsOptions,
} from '../setup/sign-ins.js';
import { quarterdeckHome } from '../store/index.js';
import type { UpgradeHandler } from '../stream/socket.js';
import { createWorkspaces, type Workspaces } from '../workspace/index.js';
import type { ApiContext, ApiVoyages } from './context.js';
import {
  createOpenRequests,
  type OpenRequestsOptions,
} from './open-requests.js';
import {
  createProjectStores,
  type ProjectHooks,
  type ProjectStores,
} from './project-stores.js';
import { localGuard } from './request.js';
import { handleRequest } from './routes.js';
import { createApiToken, removeApiToken, writeApiToken } from './token.js';

export const API_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 4317;

export interface ApiServerOptions {
  port?: number;
  homeDir?: string;
  allowedOrigins?: string[];
  databaseUrl?: string | undefined;
  dashboardDir?: string | undefined;
  openProjects?: boolean;
  onError?: (err: unknown) => void;
  stopHosts?: StopHosts;
  token?: string;
  projectHooks?: ProjectHooks;
  voyages?: ApiVoyages;
  layouts?: GlobalLayouts;
  workspaces?: Workspaces;
  keepAwake?: KeepAwake;
  upgrade?: UpgradeHandler;
  openRequests?: Pick<OpenRequestsOptions, 'hosts' | 'refreshMs'>;
  setupProbe?: SetupProbe | undefined;
  setupSignIn?: SetupSignInsOptions | undefined;
}

export interface ApiServer {
  url: string;
  port: number;
  stores: ProjectStores;
  layouts: GlobalLayouts;
  workspaces: Workspaces;
  token: string;
  tokenPath: string;
  close: () => Promise<void>;
}

const reportError = (err: unknown): void => {
  console.error(err);
};

const seedLayout = async (
  layouts: GlobalLayouts,
  stores: ProjectStores,
  onError: (err: unknown) => void = reportError,
): Promise<void> => {
  try {
    const opened = await stores.opened();
    await layouts.seed(opened.map(({ db }) => db));
  } catch (err) {
    onError(err);
  }
};

interface ProjectSeedRow {
  slug: string;
  name: string;
  repoPath: string | null;
}

const seedWorkspace = async (
  workspaces: Workspaces,
  stores: ProjectStores,
  onError: (err: unknown) => void = reportError,
): Promise<void> => {
  try {
    const opened = await stores.opened();
    const rows = await Promise.all(
      opened.map(async ({ db, projectId }) => {
        const { rows } = await db.query<ProjectSeedRow>(
          `select slug, name, repo_path as "repoPath" from projects
           where id = $1 and archived_at is null`,
          [projectId],
        );
        return rows;
      }),
    );
    await workspaces.seed(
      rows.flat().toSorted((a, b) => a.slug.localeCompare(b.slug)),
    );
  } catch (err) {
    onError(err);
  }
};

export const startApiServer = async (
  options: ApiServerOptions = {},
): Promise<ApiServer> => {
  const homeDir = options.homeDir ?? homedir();
  const home = quarterdeckHome(homeDir);
  const stores = createProjectStores(
    home,
    options.databaseUrl,
    options.onError,
    options.stopHosts,
    options.projectHooks,
  );
  const openRequests = createOpenRequests({
    ...options.openRequests,
    stores,
    homeDir,
  });
  const layouts = options.layouts ?? createGlobalLayouts(home);
  const workspaces = options.workspaces ?? createWorkspaces(home);
  const setupSignIns = createSetupSignIns(options.setupSignIn);
  const ctx: ApiContext = {
    stores,
    homeDir,
    layouts,
    workspaces,
    openRequests,
    voyages: options.voyages,
    setupProbe: options.setupProbe,
    setupSignIns,
    keepAwake: options.keepAwake,
  };
  const token = options.token ?? createApiToken();
  let guard = localGuard(0, token);
  const server = createServer((req, res) => {
    void handleRequest(ctx, guard, req, res, options.dashboardDir);
  });
  if (options.upgrade) server.on('upgrade', options.upgrade);
  server.listen(options.port ?? DEFAULT_API_PORT, API_HOST);
  try {
    await once(server, 'listening');
  } catch (err) {
    await stores.closeAll();
    throw err;
  }
  const { port } = server.address() as AddressInfo;
  guard = localGuard(port, token, options.allowedOrigins);
  const close = async () => {
    setupSignIns.close();
    await closeAllAcpClients();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await stores.closeAll();
    await removeApiToken(token, home);
  };
  let tokenPath: string;
  try {
    tokenPath = await writeApiToken(token, home);
  } catch (err) {
    await close();
    throw err;
  }
  if (options.openProjects) {
    try {
      await stores.openAll();
    } catch (err) {
      await close();
      throw err;
    }
    await seedLayout(layouts, stores, options.onError);
    await seedWorkspace(workspaces, stores, options.onError);
  }
  return {
    url: `http://${API_HOST}:${port}`,
    port,
    stores,
    layouts,
    workspaces,
    token,
    tokenPath,
    close,
  };
};
