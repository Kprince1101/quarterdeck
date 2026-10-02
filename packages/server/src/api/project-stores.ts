import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode } from '../lib/errors.js';
import { pathExists } from '../lib/fs.js';
import { PROJECT_SLUG } from '../lib/slug.js';
import { lockDataDir } from '../store/lock.js';
import {
  configuredDatabaseUrl,
  createPostgresPool,
  listProjectSlugs,
  openStore,
  projectDataDir,
  projectRowExists,
  redactUrl,
  wipePostgresProject,
  type Store,
} from '../store/index.js';
import { asLockConflict, conflict, notFound } from './http-error.js';

export interface ProjectStores {
  dataHome: string;
  location: string;
  get: (project: string) => Promise<Store>;
  create: (project: string) => Promise<Store>;
  wipe: (project: string) => Promise<void>;
  wipeAll: () => Promise<string[]>;
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
    const lock = await lockDataDir(`${pgDir}.lock`, project);
    try {
      await rm(join(dataHome, project), { recursive: true, force: true });
    } finally {
      await lock.release();
    }
  },
  close: () => Promise.resolve(),
});

const postgresCatalog = (url: string): ProjectCatalog => {
  const pool = createPostgresPool(url);
  return {
    location: redactUrl(url),
    exists: (project) => projectRowExists(pool, project),
    list: () => listProjectSlugs(pool),
    wipe: async (project) => {
      await wipePostgresProject(url, project);
    },
    close: () => pool.close(),
  };
};

const chooseCatalog = (
  dataHome: string,
  databaseUrl: string | undefined,
): ProjectCatalog => {
  if (databaseUrl === undefined) return directoryCatalog(dataHome);
  return postgresCatalog(databaseUrl);
};

export const createProjectStores = (
  dataHome: string,
  databaseUrl?: string,
): ProjectStores => {
  const url = configuredDatabaseUrl(databaseUrl);
  const catalog = chooseCatalog(dataHome, url);
  const open = new Map<string, Promise<Store>>();

  const exists = async (project: string) =>
    open.has(project) || catalog.exists(project);

  const openProject = (project: string) =>
    openStore({ project, home: dataHome, databaseUrl: url });

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

  const wipeProject = async (project: string) => {
    await release(project);
    await catalog.wipe(project).catch((err: unknown) => {
      throw asLockConflict(err);
    });
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
    wipe: async (project) => {
      if (!(await exists(project))) {
        throw notFound(`project ${project} does not exist`);
      }
      await wipeProject(project);
    },
    wipeAll: async () => {
      const projects = await catalog.list();
      for (const project of projects) await wipeProject(project);
      return projects;
    },
    closeAll: async () => {
      await Promise.all([...open.keys()].map(release));
      await catalog.close();
    },
  };
};
