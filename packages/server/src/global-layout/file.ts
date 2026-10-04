import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  gridLayoutSchema,
  parseGridLayout,
  type GridLayout,
} from '../layouts/index.js';
import { readTextIfExists } from '../lib/fs.js';
import { ensurePrivateDir, writePrivateFile } from '../lib/private-fs.js';
import { quarterdeckHome } from '../store/index.js';

export const GLOBAL_LAYOUT_FILE = 'layout.json';

const layoutFileSchema = z.object({
  spec: gridLayoutSchema,
  updatedAt: z.iso.datetime(),
});

export type GlobalLayout = z.infer<typeof layoutFileSchema>;

export const globalLayoutPath = (home: string = quarterdeckHome()): string =>
  join(home, GLOBAL_LAYOUT_FILE);

const parseLayoutFile = (text: string): GlobalLayout | null => {
  try {
    const parsed = layoutFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    return null;
  } catch {
    return null;
  }
};

export const readGlobalLayout = async (
  home: string,
): Promise<GlobalLayout | null> => {
  const text = await readTextIfExists(globalLayoutPath(home));
  if (text === null) return null;
  return parseLayoutFile(text);
};

export const writeGlobalLayout = async (
  home: string,
  spec: GridLayout,
): Promise<GlobalLayout> => {
  const layout: GlobalLayout = {
    spec: parseGridLayout(spec),
    updatedAt: new Date().toISOString(),
  };
  const path = globalLayoutPath(home);
  const staged = `${path}.${randomUUID()}.tmp`;
  await ensurePrivateDir(home);
  try {
    await writePrivateFile(staged, `${JSON.stringify(layout)}\n`);
    await rename(staged, path);
  } catch (err) {
    await rm(staged, { force: true });
    throw err;
  }
  return layout;
};
