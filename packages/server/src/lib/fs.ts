import { access, readFile } from 'node:fs/promises';
import { hasErrorCode } from './errors.js';

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
};

export const readTextIfExists = async (
  path: string,
): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
};
