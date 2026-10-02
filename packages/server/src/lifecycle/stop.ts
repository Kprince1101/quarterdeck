import {
  AGENT_COLUMNS,
  AgentFinishedError,
  FINISHED_AGENT_STATUSES,
  agentProcess,
  gitWorktrees,
  killAgent,
  sweepAgentProcess,
  type Agent,
  type SessionHost,
  type WorktreeHost,
} from '../agents/index.js';
import { ARCHIVE_KIND } from '../pause/index.js';
import { publishEvent, type Store } from '../store/index.js';

export const WIPE_REASON = 'wipe';

export interface StopHosts {
  sessions: SessionHost;
  worktrees: Pick<WorktreeHost, 'remove'>;
  killGraceMs?: number;
}

export interface StoppedAgents {
  killed: string[];
  running: string[];
}

export const noSessions: SessionHost = {
  open: () => Promise.reject(new Error('this server holds no sessions')),
  close: () => Promise.resolve(),
};

export const DEFAULT_STOP_HOSTS: StopHosts = {
  sessions: noSessions,
  worktrees: gitWorktrees,
};

const reportError = (err: unknown): void => {
  console.error('quarterdeck could not remove a worktree', err);
};

const archiveForWipe = (store: Store): Promise<void> =>
  store.db.transaction(async (tx) => {
    await tx.query(
      `update projects set archived_at = coalesce(archived_at, now())
       where id = $1`,
      [store.projectId],
    );
    await publishEvent(tx, store.projectId, {
      kind: ARCHIVE_KIND,
      payload: { archived: true, reason: WIPE_REASON },
    });
  });

const projectAgents = async (store: Store): Promise<Agent[]> => {
  const { rows } = await store.db.query<Agent>(
    `select ${AGENT_COLUMNS} from agents
     where project_id = $1
     order by created_at, id`,
    [store.projectId],
  );
  return rows;
};

const kill = async (
  store: Store,
  hosts: StopHosts,
  agent: Agent,
): Promise<boolean> => {
  if (FINISHED_AGENT_STATUSES.includes(agent.status)) return false;
  try {
    await killAgent(store, hosts, agent.id);
    return true;
  } catch (err) {
    if (err instanceof AgentFinishedError) return false;
    throw err;
  }
};

const stopAgent = async (
  store: Store,
  hosts: StopHosts,
  agent: Agent,
): Promise<boolean> => {
  if (await kill(store, hosts, agent)) return true;
  await sweepAgentProcess(store, agent, WIPE_REASON, hosts.killGraceMs);
  return false;
};

const removeWorktree = async (
  hosts: StopHosts,
  agent: Agent,
  onError: (err: unknown) => void,
): Promise<void> => {
  if (agent.worktreePath === null) return;
  await hosts.worktrees
    .remove(agent.worktreePath, { force: true })
    .catch(onError);
};

export const stopProjectAgents = async (
  store: Store,
  hosts: StopHosts,
  onError: (err: unknown) => void = reportError,
): Promise<StoppedAgents> => {
  await archiveForWipe(store);
  const stopped: StoppedAgents = { killed: [], running: [] };
  for (const agent of await projectAgents(store)) {
    if (await stopAgent(store, hosts, agent)) stopped.killed.push(agent.name);
    if (await agentProcess(store.db, agent.id)) {
      stopped.running.push(agent.name);
    }
    await removeWorktree(hosts, agent, onError);
  }
  return stopped;
};
