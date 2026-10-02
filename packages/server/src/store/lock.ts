import { open, readFile, rm } from 'node:fs/promises';
import { hasErrorCode as hasCode } from '../lib/errors.js';

export interface DataDirLock {
  release: () => Promise<void>;
}

export const NO_LOCK: DataDirLock = { release: () => Promise.resolve() };

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, 'EPERM');
  }
};

const writeLock = async (path: string): Promise<void> => {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(String(process.pid));
  } finally {
    await handle.close();
  }
};

const readHolder = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return '';
    throw err;
  }
};

const holderPid = async (path: string): Promise<number | undefined> => {
  const pid = Number.parseInt(await readHolder(path), 10);
  if (Number.isInteger(pid) && pid > 0) return pid;
  return undefined;
};

const takeLock = async (
  path: string,
  project: string,
  reclaimStale: boolean,
): Promise<DataDirLock> => {
  try {
    await writeLock(path);
    return { release: () => rm(path, { force: true }) };
  } catch (err) {
    if (!hasCode(err, 'EEXIST')) throw err;
    const pid = await holderPid(path);
    if (pid !== undefined && isAlive(pid)) {
      throw new Error(`project ${project} is already open (pid ${pid})`, {
        cause: err,
      });
    }
    if (!reclaimStale) throw err;
    await rm(path, { force: true });
    return takeLock(path, project, false);
  }
};

export const lockDataDir = (
  path: string,
  project: string,
): Promise<DataDirLock> => takeLock(path, project, true);
