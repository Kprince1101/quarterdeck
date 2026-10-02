import {
  countTables,
  dataPaths,
  isStoreTable,
  readTablePage,
  withPresence,
} from '../../data/index.js';
import type { DataIntentName, DataSummary } from '../../intents/index.js';
import type { Queryable, Store } from '../../store/index.js';
import type { IntentHandlers } from '../context.js';
import { notFound } from '../http-error.js';
import { findRow, unrecorded } from '../record.js';

const repoPathOf = async (db: Queryable, projectId: string) => {
  const { repo_path } = await findRow<{ repo_path: string | null }>(
    db,
    'select repo_path from projects where id = $1',
    [projectId],
    'project row not found',
  );
  return repo_path;
};

const databaseOf = (store: Store): string | undefined => {
  if (store.backend === 'postgres') return store.location;
  return undefined;
};

export const DATA_HANDLERS: IntentHandlers<DataIntentName> = {
  'data.summary': async (ctx, input, name) => {
    const store = await ctx.stores.get(input.project);
    const paths = dataPaths({
      homeDir: ctx.homeDir,
      project: input.project,
      repoPath: await repoPathOf(store.db, store.projectId),
      database: databaseOf(store),
    });
    const summary: DataSummary = {
      backend: store.backend,
      tables: await countTables(store.db, store.projectId),
      paths: await withPresence(paths),
    };
    return unrecorded(name, summary);
  },
  'data.rows': async (ctx, input, name) => {
    if (!isStoreTable(input.table)) {
      throw notFound(`table ${input.table} not found`);
    }
    const store = await ctx.stores.get(input.project);
    const page = await readTablePage(store.db, store.projectId, input.table, {
      offset: input.offset,
      limit: input.limit,
    });
    return unrecorded(name, page);
  },
};
