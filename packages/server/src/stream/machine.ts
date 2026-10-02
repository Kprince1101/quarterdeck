import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { hasErrorCode } from '../lib/errors.js';
import { globalPausePath } from '../pause/state.js';
import type { MachineState } from './schema.js';

export const MACHINE_EVENT_KINDS: ReadonlySet<string> = new Set(['pause.all']);

const pauseFileSchema = z.object({ pausedAt: z.iso.datetime() });

const parsePausedAt = (text: string): string | null => {
  try {
    const parsed = pauseFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.pausedAt;
    return null;
  } catch {
    return null;
  }
};

const modifiedAt = async (path: string): Promise<string | null> => {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
};

export const readMachineState = async (home: string): Promise<MachineState> => {
  const path = globalPausePath(home);
  try {
    const pausedAt = parsePausedAt(await readFile(path, 'utf8'));
    if (pausedAt !== null) return { pausedAt };
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return { pausedAt: null };
  }
  return { pausedAt: await modifiedAt(path) };
};
