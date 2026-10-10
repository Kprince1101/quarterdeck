import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RecordedProcess } from '../acp/client/index.js';
import { readTextIfExists } from '../lib/fs.js';
import { ensurePrivateDir, writePrivateFile } from '../lib/private-fs.js';

export const KEEP_AWAKE_FILE = 'keep-awake.json';

const recordSchema = z.object({
  pid: z.int().positive(),
  startedAt: z.iso.datetime(),
});

export const keepAwakePath = (home: string): string =>
  join(home, KEEP_AWAKE_FILE);

export const writeKeepAwakeRecord = async (
  home: string,
  recorded: RecordedProcess,
): Promise<void> => {
  await ensurePrivateDir(home);
  await writePrivateFile(
    keepAwakePath(home),
    `${JSON.stringify({ pid: recorded.pid, startedAt: recorded.startedAt.toISOString() })}\n`,
  );
};

const parseRecord = (text: string): RecordedProcess | null => {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return { pid: parsed.data.pid, startedAt: new Date(parsed.data.startedAt) };
  } catch {
    return null;
  }
};

export const readKeepAwakeRecord = async (
  home: string,
): Promise<RecordedProcess | null> => {
  const text = await readTextIfExists(keepAwakePath(home));
  if (text === null) return null;
  return parseRecord(text);
};

export const removeKeepAwakeRecord = (home: string): Promise<void> =>
  rm(keepAwakePath(home), { force: true });
