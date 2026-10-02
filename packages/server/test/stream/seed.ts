import type { Store } from '../../src/store/index.js';

export const CLEAR_TABLES = [
  'events',
  'turns',
  'cards',
  'notebook_proposals',
  'notebook',
  'charter_proposals',
  'budget',
  'layouts',
  'tickets',
  'agents',
  'rounds',
]
  .map((table) => `delete from ${table};`)
  .join('\n');

const insert = async (
  store: Store,
  sql: string,
  params: unknown[],
): Promise<string> => {
  const {
    rows: [row],
  } = await store.db.query<{ id: string }>(`${sql} returning id`, params);
  if (!row) throw new Error(`nothing inserted by ${sql}`);
  return row.id;
};

export const seedEveryTable = async (store: Store): Promise<void> => {
  const project = store.projectId;
  const roundId = await insert(
    store,
    `insert into rounds (project_id, number, goal) values ($1, 1, 'ship QD6b')`,
    [project],
  );
  const agentId = await insert(
    store,
    `insert into agents (project_id, round_id, name, role, status, worktree_path)
     values ($1, $2, 'pangolin', 'builder', 'working', '/tmp/pangolin')`,
    [project, roundId],
  );
  const ticketId = await insert(
    store,
    `insert into tickets (project_id, round_id, assignee_id, title, depends_on, pr_url)
     values ($1, $2, $3, 'QD6b', array[gen_random_uuid()], 'https://example.test/pr/1')`,
    [project, roundId, agentId],
  );
  await insert(
    store,
    `insert into cards (project_id, agent_id, ticket_id, kind, question, options)
     values ($1, $2, $3, 'merge', 'Ship it?', '["yes","no"]')`,
    [project, agentId, ticketId],
  );
  await insert(
    store,
    `insert into turns (agent_id, ticket_id, seq, prompt, input_tokens, ended_at)
     values ($1, $2, 1, 'build the socket', 1200, now())`,
    [agentId, ticketId],
  );
  const entryId = await insert(
    store,
    `insert into notebook (project_id, round_id, author_id, body, pinned)
     values ($1, $2, $3, 'keep the socket read-only', true)`,
    [project, roundId, agentId],
  );
  await insert(
    store,
    `insert into notebook_proposals
       (project_id, round_id, agent_id, op, entry_id, body, rationale)
     values ($1, $2, $3, 'update', $4, 'keep the socket strictly read-only', 'sharper')`,
    [project, roundId, agentId, entryId],
  );
  await insert(
    store,
    `insert into charter_proposals (project_id, round_id, agent_id, body, rationale)
     values ($1, $2, $3, 'be terse', 'less noise')`,
    [project, roundId, agentId],
  );
  await insert(
    store,
    `insert into budget (project_id, round_id, limit_tokens, limit_usd, spent_usd)
     values ($1, $2, 100000, 12.5, 0.75)`,
    [project, roundId],
  );
  await insert(
    store,
    `insert into layouts (project_id, name, spec)
     values ($1, 'board', '{"widgets":[{"id":"events"}]}')`,
    [project],
  );
};
