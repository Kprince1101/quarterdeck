import {
  STORE_TABLES,
  type Queryable,
  type StoreTable,
} from '../../src/store/index.js';

const COUNT_SQL: Partial<Record<StoreTable, string>> = {
  projects: 'select count(*)::int as n from projects where id = $1',
  turns: `select count(*)::int as n from turns t
          join agents a on a.id = t.agent_id where a.project_id = $1`,
};

const countSql = (table: StoreTable): string =>
  COUNT_SQL[table] ??
  `select count(*)::int as n from "${table}" where project_id = $1`;

export const projectRowCounts = async (
  db: Queryable,
  projectId: string,
): Promise<Record<string, number>> => {
  const counts = await Promise.all(
    STORE_TABLES.map(async (table) => {
      const { rows } = await db.query<{ n: number }>(countSql(table), [
        projectId,
      ]);
      return [table, rows[0]?.n ?? 0] as const;
    }),
  );
  return Object.fromEntries(counts);
};

export const seedProject = async (
  db: Queryable,
  projectId: string,
): Promise<void> => {
  await db.query(
    `
    with p as (select $1::uuid as id),
    round as (
      insert into rounds (project_id, number) select id, 1 from p returning id
    ),
    agent as (
      insert into agents (project_id, round_id, name, role)
      select p.id, round.id, 'pangolin', 'builder' from p, round returning id
    ),
    ticket as (
      insert into tickets (project_id, title, assignee_id)
      select p.id, 'QD2c', agent.id from p, agent returning id
    ),
    turn as (
      insert into turns (agent_id, ticket_id, seq, prompt)
      select agent.id, ticket.id, 1, 'go' from agent, ticket returning id
    ),
    card as (
      insert into cards (project_id, agent_id, ticket_id, kind, question)
      select p.id, agent.id, ticket.id, 'gate', 'ok?' from p, agent, ticket
      returning id
    ),
    event as (
      insert into events (project_id, agent_id, kind)
      select p.id, agent.id, 'seeded' from p, agent returning id
    ),
    note as (
      insert into notebook (project_id, body) select id, 'note' from p
      returning id
    ),
    proposal as (
      insert into charter_proposals (project_id, body) select id, 'be kind' from p
      returning id
    ),
    spend as (
      insert into budget (project_id, round_id, limit_tokens)
      select p.id, round.id, 10 from p, round returning id
    ),
    layout as (
      insert into layouts (project_id, name, spec)
      select id, 'default', '{}' from p returning id
    ),
    intent as (
      insert into intents (project_id, kind, input, status)
      select id, 'seed', '{}', 'pending' from p returning id
    )
    select 1`,
    [projectId],
  );
};
