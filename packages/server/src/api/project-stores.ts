import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode } from '../lib/errors.js';
import { pathExists } from '../lib/fs.js';
import { PROJECT_SLUG } from '../lib/slug.js';
import { lockDataDir } from '../store/lock.js';
import { openStore, projectDataDir, type Store } from '../store/index.js';
import { asLockConflict, conflict, notFound } from './http-error.js';

export interface ProjectStores {
  dataHome: string;
  get: (project: string) => Promise<Store>;
  create: (project: string) => Promise<Store>;
  wipe: (project: string) => Promise<void>;
  wipeAll: () => Promise<string[]>;
  closeAll: () => Promise<void>;
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

export const createProjectStores = (dataHome: string): ProjectStores => {
  const open = new Map<string, Promise<Store>>();

  const dataDirExists = (project: string) =>
    pathExists(join(projectDataDir(project, dataHome), 'PG_VERSION'));

  const exists = async (project: string) =>
    open.has(project) || dataDirExists(project);

  const openProject = (project: string) =>
    openStore({ project, home: dataHome });

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
    if (await dataDirExists(project)) {
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

  const wipeDir = async (project: string) => {
    await release(project);
    const pgDir = projectDataDir(project, dataHome);
    const lock = await lockDataDir(`${pgDir}.lock`, project).catch(
      (err: unknown) => {
        throw asLockConflict(err);
      },
    );
    try {
      await rm(join(dataHome, project), { recursive: true, force: true });
    } finally {
      await lock.release();
    }
  };

  return {
    dataHome,
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
      await wipeDir(project);
    },
    wipeAll: async () => {
      const projects = await projectDirs(dataHome);
      for (const project of projects) await wipeDir(project);
      return projects;
    },
    closeAll: async () => {
      await Promise.all([...open.keys()].map(release));
    },
  };
};
