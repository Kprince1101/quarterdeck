import {
  WorktreeDirtyError,
  findAgent,
  requestWorktreeDiscard,
  type AgentLifecycle,
} from '../agents/index.js';
import { RoundNotFoundError } from '../driver/index.js';
import { publishEvent, type Store } from '../store/index.js';

export const ROUND_ENDED_EVENT = 'round.ended';

export const ROUND_AGENT_ROLES: readonly string[] = ['driver', 'builder'];

export interface CleanUpOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  roundId: string;
  reason: string;
}

export interface RoundCleanup {
  roundId: string;
  round: number;
  ended: boolean;
  retired: string[];
  discardCards: string[];
}

const roundAgents = async (
  store: Store,
  roundId: string,
): Promise<string[]> => {
  const { rows } = await store.db.query<{ id: string }>(
    `select id from agents
     where project_id = $1 and round_id = $2 and role = any($3::text[])
       and status <> 'retired'
     order by created_at, id`,
    [store.projectId, roundId, ROUND_AGENT_ROLES],
  );
  return rows.map((row) => row.id);
};

const roundNumber = async (store: Store, roundId: string): Promise<number> => {
  const { rows } = await store.db.query<{ number: number }>(
    'select number from rounds where id = $1 and project_id = $2',
    [roundId, store.projectId],
  );
  const [round] = rows;
  if (!round) throw new RoundNotFoundError(roundId);
  return round.number;
};

const retireOrAsk = async (
  options: CleanUpOptions,
  agentId: string,
): Promise<{ retired?: string; discardCard?: string }> => {
  try {
    await options.lifecycle.retire(options.store, agentId);
    return { retired: agentId };
  } catch (err) {
    if (!(err instanceof WorktreeDirtyError)) throw err;
    const agent = await findAgent(options.store, agentId);
    return {
      discardCard: await requestWorktreeDiscard(options.store, agent, err),
    };
  }
};

const markEnded = (
  options: CleanUpOptions,
  cleanup: Omit<RoundCleanup, 'ended'>,
): Promise<boolean> =>
  options.store.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `update rounds set status = 'ended', ended_at = now()
       where id = $1 and project_id = $2 and status <> 'ended'
       returning id`,
      [options.roundId, options.store.projectId],
    );
    if (rows.length === 0) return false;
    await publishEvent(tx, options.store.projectId, {
      kind: ROUND_ENDED_EVENT,
      payload: { ...cleanup, reason: options.reason },
    });
    return true;
  });

export const cleanUpRound = async (
  options: CleanUpOptions,
): Promise<RoundCleanup> => {
  const { store, roundId } = options;
  const round = await roundNumber(store, roundId);
  const retired: string[] = [];
  const discardCards: string[] = [];
  for (const agentId of await roundAgents(store, roundId)) {
    const step = await retireOrAsk(options, agentId);
    if (step.retired !== undefined) retired.push(step.retired);
    if (step.discardCard !== undefined) discardCards.push(step.discardCard);
  }
  const cleanup = { roundId, round, retired, discardCards };
  return { ...cleanup, ended: await markEnded(options, cleanup) };
};
