import { publishEvent, type Store, type StoreEvent } from '../store/index.js';
import { settleIntent } from '../planner/rows.js';

export const VOYAGE_OPENED_EVENT = 'voyage.started';

export interface OpenedVoyage {
  id: string;
  number: number;
  goal: string;
}

export type VoyageOpening =
  { opened: true; voyage: OpenedVoyage } | { opened: false; error: string };

export const voyageStillOpen = (number: number): string =>
  `voyage ${number} is still open; end it first`;

export const activeVoyageIds = async (
  store: Pick<Store, 'db' | 'projectId'>,
): Promise<string[]> => {
  const { rows } = await store.db.query<{ id: string }>(
    `select id from voyages where project_id = $1 and status <> 'ended'
     order by number`,
    [store.projectId],
  );
  return rows.map((row) => row.id);
};

export const voyageEnded = async (
  store: Pick<Store, 'db' | 'projectId'>,
  voyageId: string,
): Promise<boolean> => {
  const { rows } = await store.db.query<{ status: string }>(
    'select status from voyages where id = $1 and project_id = $2',
    [voyageId, store.projectId],
  );
  return rows[0]?.status !== 'active';
};

export const voyageIdOf = (event: StoreEvent): string | undefined => {
  const { payload } = event;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const voyageId = (payload as Record<string, unknown>)['voyageId'];
  if (typeof voyageId !== 'string') return undefined;
  return voyageId;
};

export const openVoyage = (
  store: Pick<Store, 'db' | 'projectId'>,
  intentId: string,
  goal: string,
): Promise<VoyageOpening> =>
  store.db.transaction(async (tx) => {
    await tx.query('select id from projects where id = $1 for update', [
      store.projectId,
    ]);
    const { rows: open } = await tx.query<{ number: number }>(
      `select number from voyages where project_id = $1 and status <> 'ended'
       order by number limit 1`,
      [store.projectId],
    );
    const [still] = open;
    if (still) return { opened: false, error: voyageStillOpen(still.number) };
    const { rows } = await tx.query<OpenedVoyage>(
      `insert into voyages (project_id, number, status, goal)
       select $1, coalesce(max(number), 0) + 1, 'active', $2
       from voyages where project_id = $1
       returning id, number, goal`,
      [store.projectId, goal],
    );
    const [voyage] = rows;
    if (!voyage) throw new Error('the voyage was not created');
    await settleIntent(tx, intentId, 'applied', {
      voyageId: voyage.id,
      voyage: voyage.number,
    });
    await publishEvent(tx, store.projectId, {
      kind: VOYAGE_OPENED_EVENT,
      payload: { intentId, voyageId: voyage.id, voyage: voyage.number, goal },
    });
    return { opened: true, voyage };
  });
