import { chmod, mkdir, open, stat } from 'node:fs/promises';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const GROUP_AND_OTHER = 0o077;

const hasPosixModes = (): boolean => process.platform !== 'win32';

export const ensurePrivateDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!hasPosixModes()) return;
  const { mode } = await stat(dir);
  if ((mode & GROUP_AND_OTHER) !== 0) await chmod(dir, PRIVATE_DIR_MODE);
};

export const writePrivateFile = async (
  path: string,
  data: string,
): Promise<void> => {
  const handle = await open(path, 'w', PRIVATE_FILE_MODE);
  try {
    if (hasPosixModes()) await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
};
