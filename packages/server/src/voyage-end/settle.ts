import {
  ACTIVE_TICKET_STATUSES,
  APPROVED_TICKET_STATUS,
} from '../driver/index.js';
import { pausedScopes } from '../pause/index.js';
import { quarterdeckHome, type Queryable } from '../store/index.js';

export const OPEN_TICKET_STATUSES: readonly string[] = [
  APPROVED_TICKET_STATUS,
  ...ACTIVE_TICKET_STATUSES,
];

export const RUNNING_AGENT_STATUSES: readonly string[] = [
  'starting',
  'working',
  'stuck',
];

export interface SettleState {
  voyageEnded: boolean;
  openTickets: number;
  runningAgents: number;
  openCards: number;
  paused: boolean;
}

type CountedState = Omit<SettleState, 'paused'>;

export const readSettleState = async (
  db: Queryable,
  projectId: string,
  voyageId: string,
  home: string = quarterdeckHome(),
): Promise<SettleState> => {
  const { rows } = await db.query<CountedState>(
    `select
       coalesce((select status = 'ended' from voyages
                 where id = $2 and project_id = $1), true) as "voyageEnded",
       (select count(*)::int from tickets
        where project_id = $1 and status = any($3::text[])) as "openTickets",
       (select count(*)::int from agents
        where project_id = $1 and status = any($4::text[])) as "runningAgents",
       (select count(*)::int from cards
        where project_id = $1 and status = 'open') as "openCards"`,
    [projectId, voyageId, OPEN_TICKET_STATUSES, RUNNING_AGENT_STATUSES],
  );
  const [state] = rows;
  if (!state) throw new Error(`no settle state for voyage ${voyageId}`);
  const paused = (await pausedScopes(db, projectId, home)).length > 0;
  return { ...state, paused };
};

export const isSettled = (state: SettleState): boolean =>
  !state.voyageEnded &&
  !state.paused &&
  state.openTickets === 0 &&
  state.runningAgents === 0 &&
  state.openCards === 0;
