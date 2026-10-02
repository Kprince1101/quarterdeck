import { getErrorMessage, type Runtime } from '@quarterdeck/rules';
import type { Store } from '../store/index.js';
import { AGENT_COLUMNS, type Agent, type AgentRole } from './agent.js';
import { firstRow, markRetired, recordEvent } from './rows.js';
import type { SessionHost } from './sessions.js';

export interface BirthRequest {
  store: Store;
  role: AgentRole;
  runtime: Runtime;
  roundId?: string;
}

export const insertAgent = (
  request: BirthRequest,
  name: string,
): Promise<Agent> =>
  request.store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `insert into agents (project_id, round_id, name, role, runtime)
       values ($1, $2, $3, $4, $5)
       returning ${AGENT_COLUMNS}`,
      [
        request.store.projectId,
        request.roundId ?? null,
        name,
        request.role,
        request.runtime,
      ],
    );
    const agent = firstRow(rows, name);
    await recordEvent(tx, agent, 'agent.born', {
      name,
      role: agent.role,
      runtime: agent.runtime,
    });
    return agent;
  });

const attachSession = async (
  store: Store,
  agent: Agent,
  sessionId: string,
): Promise<Agent> => {
  const { rows } = await store.db.query<Agent>(
    `update agents set session_id = $2, status = 'idle'
     where id = $1
     returning ${AGENT_COLUMNS}`,
    [agent.id, sessionId],
  );
  return firstRow(rows, agent.id);
};

const retireUnborn = async (
  store: Store,
  agent: Agent,
  openError: unknown,
): Promise<void> => {
  try {
    await markRetired(store, agent, 'agent.birth_failed', {
      error: getErrorMessage(openError),
    });
  } catch (retireError) {
    throw new AggregateError(
      [openError, retireError],
      `${agent.name} could not open a session and could not be retired`,
    );
  }
};

export const openSession = async (
  store: Store,
  sessions: SessionHost,
  agent: Agent,
): Promise<Agent> => {
  try {
    return await attachSession(store, agent, await sessions.open(agent));
  } catch (err) {
    await retireUnborn(store, agent, err);
    throw err;
  }
};
