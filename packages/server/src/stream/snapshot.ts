import {
  WATCHED_TABLES,
  readRows,
  type Row,
  type Store,
  type WatchedTable,
} from '../store/index.js';

export const SNAPSHOT_TURNS_PER_AGENT = 20;

export type SnapshotRows = Record<WatchedTable, Row[]>;

export const readSnapshot = (
  store: Store,
  turnsPerAgent = SNAPSHOT_TURNS_PER_AGENT,
): Promise<SnapshotRows> =>
  store.db.transaction(async (tx) => {
    await tx.exec('set transaction isolation level repeatable read, read only');
    const tables = await Promise.all(
      WATCHED_TABLES.map(
        async (table) =>
          [
            table,
            await readRows(tx, store.projectId, table, { turnsPerAgent }),
          ] as const,
      ),
    );
    return Object.fromEntries(tables) as SnapshotRows;
  });

export const tailCursor = async (
  store: Store,
  count: number,
): Promise<number> => {
  const { rows } = await store.db.query<{ id: number }>(
    `select coalesce((
       select id from events where project_id = $1
       order by id desc offset $2 limit 1
     ), 0)::int8 as id`,
    [store.projectId, count],
  );
  return Number(rows[0]?.id ?? 0);
};
