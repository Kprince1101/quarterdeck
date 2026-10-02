import { publishEvent, type Store, type StoreEvent } from '../store/index.js';
import { settleIntent } from '../planner/rows.js';

export const ROUND_OPENED_EVENT = 'round.started';

export interface OpenedRound {
  id: string;
  number: number;
  goal: string;
}

export type RoundOpening =
  { opened: true; round: OpenedRound } | { opened: false; error: string };

export const roundStillOpen = (number: number): string =>
  `round ${number} is still open; end it first`;

export const activeRoundIds = async (
  store: Pick<Store, 'db' | 'projectId'>,
): Promise<string[]> => {
  const { rows } = await store.db.query<{ id: string }>(
    `select id from rounds where project_id = $1 and status <> 'ended'
     order by number`,
    [store.projectId],
  );
  return rows.map((row) => row.id);
};

export const roundEnded = async (
  store: Pick<Store, 'db' | 'projectId'>,
  roundId: string,
): Promise<boolean> => {
  const { rows } = await store.db.query<{ status: string }>(
    'select status from rounds where id = $1 and project_id = $2',
    [roundId, store.projectId],
  );
  return rows[0]?.status !== 'active';
};

export const roundIdOf = (event: StoreEvent): string | undefined => {
  const { payload } = event;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const roundId = (payload as Record<string, unknown>)['roundId'];
  if (typeof roundId !== 'string') return undefined;
  return roundId;
};

export const openRound = (
  store: Pick<Store, 'db' | 'projectId'>,
  intentId: string,
  goal: string,
): Promise<RoundOpening> =>
  store.db.transaction(async (tx) => {
    await tx.query('select id from projects where id = $1 for update', [
      store.projectId,
    ]);
    const { rows: open } = await tx.query<{ number: number }>(
      `select number from rounds where project_id = $1 and status <> 'ended'
       order by number limit 1`,
      [store.projectId],
    );
    const [still] = open;
    if (still) return { opened: false, error: roundStillOpen(still.number) };
    const { rows } = await tx.query<OpenedRound>(
      `insert into rounds (project_id, number, status, goal)
       select $1, coalesce(max(number), 0) + 1, 'active', $2
       from rounds where project_id = $1
       returning id, number, goal`,
      [store.projectId, goal],
    );
    const [round] = rows;
    if (!round) throw new Error('the round was not created');
    await settleIntent(tx, intentId, 'applied', {
      roundId: round.id,
      round: round.number,
    });
    await publishEvent(tx, store.projectId, {
      kind: ROUND_OPENED_EVENT,
      payload: { intentId, roundId: round.id, round: round.number, goal },
    });
    return { opened: true, round };
  });
