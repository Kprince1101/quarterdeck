import {
  DEFAULT_KILL_GRACE_MS,
  isTreeAlive,
  stopOwnTree,
  type AcpClientListener,
  type OwnedTreeStop,
  type RecordedProcess,
} from '../acp/client/index.js';
import type { Queryable, Store } from '../store/index.js';
import type { Agent } from './agent.js';
import { recordEvent } from './rows.js';

export const PROCESS_SWEPT_EVENT = 'agent.process_swept';

export type SweepReason = 'kill' | 'reset' | 'retire' | 'restart' | 'wipe';

export type SweepOutcome = 'none' | OwnedTreeStop;

const LOGGED_OUTCOMES: ReadonlySet<SweepOutcome> = new Set([
  'terminated',
  'killed',
  'unverified',
]);

export const recordAgentProcess = async (
  db: Queryable,
  agentId: string,
  recorded: RecordedProcess,
): Promise<void> => {
  await db.query(
    `update agents set pid = $2, pid_started_at = $3 where id = $1`,
    [agentId, recorded.pid, recorded.startedAt],
  );
};

export const forgetAgentProcess = async (
  db: Queryable,
  agentId: string,
  pid: number,
): Promise<void> => {
  await db.query(
    `update agents set pid = null, pid_started_at = null
     where id = $1 and pid = $2`,
    [agentId, pid],
  );
};

export const agentProcess = async (
  db: Queryable,
  agentId: string,
): Promise<RecordedProcess | undefined> => {
  const { rows } = await db.query<RecordedProcess>(
    `select pid, pid_started_at as "startedAt" from agents
     where id = $1 and pid is not null`,
    [agentId],
  );
  return rows[0];
};

export const sweepAgentProcess = async (
  store: Store,
  agent: Agent,
  reason: SweepReason,
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<SweepOutcome> => {
  const recorded = await agentProcess(store.db, agent.id);
  if (!recorded) return 'none';
  const outcome = await stopOwnTree(recorded, graceMs);
  await store.db.transaction(async (tx) => {
    if (outcome !== 'unverified')
      await forgetAgentProcess(tx, agent.id, recorded.pid);
    if (!LOGGED_OUTCOMES.has(outcome)) return;
    await recordEvent(tx, agent, PROCESS_SWEPT_EVENT, {
      name: agent.name,
      pid: recorded.pid,
      reason,
      outcome,
    });
  });
  return outcome;
};

const reportError = (err: unknown): void => {
  console.error('quarterdeck could not record an agent process', err);
};

export const trackAgentProcess = (
  store: Pick<Store, 'db'>,
  agentId: string,
  onError: (err: unknown) => void = reportError,
): AcpClientListener => {
  let pid: number | undefined;
  let writes: Promise<void> = Promise.resolve();
  const queue = (write: () => Promise<void>): void => {
    writes = writes.then(write).catch(onError);
  };
  return (event) => {
    if (event.type === 'spawned') {
      const recorded = { pid: event.pid, startedAt: new Date() };
      pid = event.pid;
      queue(() => recordAgentProcess(store.db, agentId, recorded));
    }
    if (event.type === 'exit' && pid !== undefined) {
      const exited = pid;
      queue(async () => {
        if (!isTreeAlive(exited))
          await forgetAgentProcess(store.db, agentId, exited);
      });
    }
  };
};
