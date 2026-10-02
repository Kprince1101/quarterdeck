import type { Naming } from '@quarterdeck/rules';
import type { Store } from '../store/index.js';

const LIVE_NAMES = `select a.name from agents a
  join projects p on p.id = a.project_id
  where a.status <> 'retired' and p.archived_at is null`;

export class NamesExhaustedError extends Error {
  readonly theme: string;

  constructor(theme: string) {
    super(`Every ${theme} name is taken by a live agent`);
    this.name = 'NamesExhaustedError';
    this.theme = theme;
  }
}

export const liveAgentNames = async (
  stores: readonly Store[],
): Promise<Set<string>> => {
  const results = await Promise.all(
    stores.map((store) => store.db.query<{ name: string }>(LIVE_NAMES)),
  );
  return new Set(results.flatMap(({ rows }) => rows.map((row) => row.name)));
};

export const pickAgentName = (
  naming: Naming,
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
): string => {
  const free = naming.names.filter((name) => !taken.has(name));
  const name = free[Math.floor(random() * free.length)];
  if (name === undefined) throw new NamesExhaustedError(naming.theme);
  return name;
};

let nameLock: Promise<unknown> = Promise.resolve();

export const withNameLock = <T>(task: () => Promise<T>): Promise<T> => {
  const run = nameLock.then(task);
  nameLock = run.catch(() => undefined);
  return run;
};
