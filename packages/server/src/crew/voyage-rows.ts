import { publishEvent, type Store, type StoreEvent } from '../store/index.js';

export const VOYAGE_OPENED_EVENT = 'voyage.started';

export interface VoyageLegSite {
  project: string;
  store: Store;
}

export interface OpenedLeg extends VoyageLegSite {
  voyageId: string;
}

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

const lastVoyageNumber = async (
  store: Pick<Store, 'db' | 'projectId'>,
): Promise<number> => {
  const { rows } = await store.db.query<{ number: number }>(
    `select coalesce(max(number), 0)::int as number from voyages
     where project_id = $1`,
    [store.projectId],
  );
  return rows[0]?.number ?? 0;
};

export const nextVoyageNumber = async (
  stores: readonly Pick<Store, 'db' | 'projectId'>[],
): Promise<number> => {
  const numbers = await Promise.all(stores.map(lastVoyageNumber));
  return Math.max(0, ...numbers) + 1;
};

export interface VoyageOpening {
  number: number;
  goal: string;
  projects: readonly string[];
}

export const openVoyageLeg = (
  site: VoyageLegSite,
  opening: VoyageOpening,
): Promise<OpenedLeg> =>
  site.store.db.transaction(async (tx) => {
    const { store } = site;
    const { rows } = await tx.query<{ id: string }>(
      `insert into voyages (project_id, number, status, goal, projects)
       values ($1, $2, 'active', $3, $4)
       returning id`,
      [store.projectId, opening.number, opening.goal, opening.projects],
    );
    const [row] = rows;
    if (!row) throw new Error('the voyage was not created');
    await publishEvent(tx, store.projectId, {
      kind: VOYAGE_OPENED_EVENT,
      payload: {
        voyageId: row.id,
        voyage: opening.number,
        goal: opening.goal,
        projects: opening.projects,
      },
    });
    return { ...site, voyageId: row.id };
  });
