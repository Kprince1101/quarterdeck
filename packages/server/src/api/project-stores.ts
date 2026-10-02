import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WipeResult } from '../intents/index.js';
import { hasErrorCode } from '../lib/errors.js';
import { pathExists } from '../lib/fs.js';
import { PROJECT_SLUG } from '../lib/slug.js';
import { recoverProject } from '../lifecycle/recover.js';
import {
  DEFAULT_STOP_HOSTS,
  stopProjectAgents,
  type StopHosts,
} from '../lifecycle/stop.js';
import { lockDataDir } from '../store/lock.js';
import {
  configuredDatabaseUrl,
  createPostgresPool,
  dataDirLockPath,
  listProjectSlugs,
  openStore,
  projectDataDir,
  projectDir,
  projectRowExists,
  redactUrl,
  wipePostgresProject,
  type Store,
} from '../store/index.js';
import { asLockConflict, conflict, notFound } from './http-error.js';

type StoppedAgent = WipeResult['stopped'][number];

export interface ProjectStores {
  dataHome: string;
  location: string;
  get: (project: string) => Promise<Store>;
  create: (project: string) => Promise<Store>;
  list: () => Promise<string[]>;
  wipe: (project: string) => Promise<WipeResult>;
  openAll: () => Promise<string[]>;
  wipeAll: () => Promise<WipeResult>;
  closeAll: () => Promise<void>;
}

interface ProjectCatalog {
  location: string;
  exists: (project: string) => Promise<boolean>;
  list: () => Promise<string[]>;
  wipe: (project: string) => Promise<void>;
  close: () => Promise<void>;
}

const projectDirs = async (dataHome: string): Promise<string[]> => {
  try {
    const entries = await readdir(dataHome, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && PROJECT_SLUG.test(entry.name))
      .map((entry) => entry.name)
      .toSorted();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return [];
    throw err;
  }
};

const directoryCatalog = (dataHome: string): ProjectCatalog => ({
  location: dataHome,
  exists: (project) =>
    pathExists(join(projectDataDir(project, dataHome), 'PG_VERSION')),
  list: () => projectDirs(dataHome),
  wipe: async (project) => {
    const pgDir = projectDataDir(project, dataHome);
    const lock = await lockDataDir(dataDirLockPath(pgDir), project);
    try {
      await rm(projectDir(project, dataHome), { recursive: true, force: true });
    } finally {
      await lock.release();
    }
  },
  close: () => Promise.resolve(),
});

const postgresCatalog = (url: string, dataHome: string): ProjectCatalog => {
  const pool = createPostgresPool(url);
  return {
    location: redactUrl(url),
    exists: (project) => projectRowExists(pool, project),
    list: () => listProjectSlugs(pool),
    wipe: async (project) => {
      await wipePostgresProject(url, project);
      await rm(projectDir(project, dataHome), { recursive: true, force: true });
    },
    close: () => pool.close(),
  };
};

const chooseCatalog = (
  dataHome: string,
  databaseUrl: string | undefined,
): ProjectCatalog => {
  if (databaseUrl === undefined) return directoryCatalog(dataHome);
  return postgresCatalog(databaseUrl, dataHome);
};

const reportError = (err: unknown): void => {
  console.error(err);
};

export const createProjectStores = (
  dataHome: string,
  databaseUrl?: string,
  onError: (err: unknown) => void = reportError,
  stopHosts: StopHosts = DEFAULT_STOP_HOSTS,
): ProjectStores => {
  const url = configuredDatabaseUrl(databaseUrl);
  const catalog = chooseCatalog(dataHome, url);
  const open = new Map<string, Promise<Store>>();

  const exists = async (project: string) =>
    open.has(project) || catalog.exists(project);

  const openProject = async (project: string) => {
    const store = await openStore({
      project,
      home: dataHome,
      databaseUrl: url,
    });
    await recoverProject(store).catch(onError);
    return store;
  };

  const claim = (
    project: string,
    start: (project: string) => Promise<Store>,
  ): Promise<Store> => {
    const opening = start(project).catch((err: unknown) => {
      if (open.get(project) === opening) open.delete(project);
      throw asLockConflict(err);
    });
    open.set(project, opening);
    return opening;
  };

  const openCached = (project: string): Promise<Store> =>
    open.get(project) ?? claim(project, openProject);

  const openNew = async (project: string): Promise<Store> => {
    if (await catalog.exists(project)) {
      throw conflict(`project ${project} already exists`);
    }
    return openProject(project);
  };

  const release = async (project: string) => {
    const cached = open.get(project);
    if (!cached) return;
    open.delete(project);
    const store = await cached.catch(() => undefined);
    await store?.close();
  };

  const stopAgents = async (project: string): Promise<StoppedAgent[]> => {
    if (!(await exists(project))) return [];
    const store = await openCached(project);
    const { killed, running } = await stopProjectAgents(
      store,
      stopHosts,
      onError,
    );
    if (running.length > 0) {
      throw conflict(
        `could not confirm that ${running.join(', ')} stopped; ${project} is kept so the next start sweeps them`,
      );
    }
    return killed.map((agent) => ({ project, agent }));
  };

  const wipeProject = async (project: string): Promise<StoppedAgent[]> => {
    const stopped = await stopAgents(project);
    await release(project);
    await catalog.wipe(project).catch((err: unknown) => {
      throw asLockConflict(err);
    });
    return stopped;
  };

  return {
    dataHome,
    location: catalog.location,
    get: async (project) => {
      if (!(await exists(project))) {
        throw notFound(`project ${project} does not exist`);
      }
      return openCached(project);
    },
    create: (project) => {
      if (open.has(project)) {
        return Promise.reject(conflict(`project ${project} already exists`));
      }
      return claim(project, openNew);
    },
    list: async () => {
      const listed = await catalog.list();
      const found = await Promise.all(listed.map(exists));
      return listed.filter((_project, index) => found[index]);
    },
    wipe: async (project) => {
      if (!(await exists(project))) {
        throw notFound(`project ${project} does not exist`);
      }
      return { wiped: [project], stopped: await wipeProject(project) };
    },
    openAll: async () => {
      const opened: string[] = [];
      for (const project of await catalog.list()) {
        try {
          await openCached(project);
          opened.push(project);
        } catch (err) {
          onError(err);
        }
      }
      return opened;
    },
    wipeAll: async () => {
      const projects = await catalog.list();
      const stopped: StoppedAgent[] = [];
      for (const project of projects) {
        stopped.push(...(await wipeProject(project)));
      }
      return { wiped: projects, stopped };
    },
    closeAll: async () => {
      await Promise.all([...open.keys()].map(release));
      await catalog.close();
    },
  };
};
