import { homedir } from 'node:os';
import type { ProjectHooks } from '../api/project-stores.js';
import { startApiServer, type ApiServer } from '../api/server.js';
import { createApiToken } from '../api/token.js';
import type { GitHubHost } from '../gate/index.js';
import type { PlannerAdapters } from '../planner/sessions.js';
import { quarterdeckHome } from '../store/index.js';
import { routeStreams, type Stream } from '../stream/socket.js';
import {
  startProjectServices,
  type ProjectServices,
  type ProjectServicesContext,
  type RunningProject,
} from './project-services.js';

export interface QuarterdeckOptions {
  port?: number;
  homeDir?: string;
  dashboardDir?: string | undefined;
  databaseUrl?: string | undefined;
  allowedOrigins?: string[];
  onError?: (err: unknown) => void;
  adapters?: PlannerAdapters;
  github?: GitHubHost;
  gatePollMs?: number;
}

export interface Quarterdeck {
  url: string;
  port: number;
  token: string;
  location: string;
  api: ApiServer;
  projects: ReadonlyMap<string, ProjectServices>;
  close: () => Promise<void>;
}

export const startQuarterdeck = async (
  options: QuarterdeckOptions = {},
): Promise<Quarterdeck> => {
  const homeDir = options.homeDir ?? homedir();
  const running = new Map<string, RunningProject>();
  const context: ProjectServicesContext = {
    home: quarterdeckHome(homeDir),
    homeDir,
    token: createApiToken(),
    allowedOrigins: options.allowedOrigins,
    onError: options.onError,
    openStores: () => [...running.values()].map(({ store }) => store),
    adapters: options.adapters,
    github: options.github,
    gatePollMs: options.gatePollMs,
  };
  let stopping = false;

  const projectHooks: ProjectHooks = {
    opened: async (project, store) => {
      if (stopping) return;
      const services = await startProjectServices(context, project, store);
      if (stopping) {
        await services.close();
        return;
      }
      running.set(project, services);
    },
    closing: async (project) => {
      const services = running.get(project);
      running.delete(project);
      await services?.close();
    },
  };

  const streams = (): ReadonlyMap<string, Stream> =>
    new Map([...running].map(([project, { stream }]) => [project, stream]));

  const api = await startApiServer({
    ...options,
    homeDir,
    openProjects: true,
    token: context.token,
    projectHooks,
    upgrade: routeStreams({
      token: context.token,
      allowedOrigins: options.allowedOrigins,
      streams,
    }),
  });

  const shutdown = async (): Promise<void> => {
    stopping = true;
    const projects = [...running.values()];
    running.clear();
    await Promise.all(projects.map((services) => services.close()));
    await api.close();
  };
  let closing: Promise<void> | undefined;

  return {
    url: api.url,
    port: api.port,
    token: api.token,
    location: api.stores.location,
    api,
    projects: running,
    close: () => {
      closing ??= shutdown();
      return closing;
    },
  };
};
