import type { GridLayout } from '../layouts/index.js';
import { pathExists } from '../lib/fs.js';
import type { Queryable } from '../store/index.js';
import {
  globalLayoutPath,
  readGlobalLayout,
  writeGlobalLayout,
  type GlobalLayout,
} from './file.js';
import { newestDashboardLayout } from './seed.js';

export type GlobalLayoutListener = (layout: GlobalLayout) => void;

export interface GlobalLayouts {
  read: () => Promise<GlobalLayout | null>;
  save: (spec: GridLayout) => Promise<GlobalLayout>;
  seed: (dbs: readonly Queryable[]) => Promise<GlobalLayout | null>;
  subscribe: (listener: GlobalLayoutListener) => () => void;
}

export const createGlobalLayouts = (home: string): GlobalLayouts => {
  const listeners = new Set<GlobalLayoutListener>();
  let writing: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = writing.then(work);
    writing = done.catch(() => undefined);
    return done;
  };

  const write = async (spec: GridLayout): Promise<GlobalLayout> => {
    const layout = await writeGlobalLayout(home, spec);
    listeners.forEach((listener) => listener(layout));
    return layout;
  };

  const seedFrom = async (
    dbs: readonly Queryable[],
  ): Promise<GlobalLayout | null> => {
    if (await pathExists(globalLayoutPath(home))) return null;
    const newest = await newestDashboardLayout(dbs);
    if (newest === null) return null;
    return write(newest);
  };

  return {
    read: () => readGlobalLayout(home),
    save: (spec) => inTurn(() => write(spec)),
    seed: (dbs) => inTurn(() => seedFrom(dbs)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
