export type ColumnKind =
  'uuid' | 'uuids' | 'text' | 'int' | 'numeric' | 'bool' | 'time' | 'json';

export interface ReadTable {
  columns: Readonly<Record<string, ColumnKind>>;
  scope: string;
  order: string;
}

const PROJECT_SCOPE = 'project_id = $1';

export const READ_TABLES = {
  projects: {
    columns: {
      id: 'uuid',
      slug: 'text',
      name: 'text',
      repo_path: 'text',
      tracker: 'json',
      publishes: 'bool',
      archived_at: 'time',
      created_at: 'time',
      updated_at: 'time',
    },
    scope: 'id = $1',
    order: 'id',
  },
  voyages: {
    columns: {
      id: 'uuid',
      number: 'int',
      status: 'text',
      goal: 'text',
      started_at: 'time',
      ended_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'number desc',
  },
  agents: {
    columns: {
      id: 'uuid',
      voyage_id: 'uuid',
      name: 'text',
      role: 'text',
      runtime: 'text',
      status: 'text',
      worktree_path: 'text',
      created_at: 'time',
      updated_at: 'time',
      ended_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'created_at desc',
  },
  tickets: {
    columns: {
      id: 'uuid',
      voyage_id: 'uuid',
      assignee_id: 'uuid',
      title: 'text',
      body: 'text',
      status: 'text',
      depends_on: 'uuids',
      source: 'text',
      external_id: 'text',
      external_ref: 'text',
      pr_url: 'text',
      head_sha: 'text',
      created_at: 'time',
      updated_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'created_at desc',
  },
  cards: {
    columns: {
      id: 'uuid',
      agent_id: 'uuid',
      ticket_id: 'uuid',
      kind: 'text',
      question: 'text',
      options: 'json',
      checked: 'text',
      recommendation: 'text',
      status: 'text',
      answer: 'text',
      created_at: 'time',
      answered_at: 'time',
      expires_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'created_at desc',
  },
  turns: {
    columns: {
      id: 'int',
      agent_id: 'uuid',
      ticket_id: 'uuid',
      seq: 'int',
      prompt: 'text',
      stop_reason: 'text',
      input_tokens: 'int',
      output_tokens: 'int',
      transcript_path: 'text',
      started_at: 'time',
      ended_at: 'time',
    },
    scope: 'agent_id in (select id from agents where project_id = $1)',
    order: 'id desc',
  },
  events: {
    columns: {
      id: 'int',
      agent_id: 'uuid',
      ticket_id: 'uuid',
      kind: 'text',
      payload: 'json',
      created_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'id desc',
  },
  notebook: {
    columns: {
      id: 'uuid',
      voyage_id: 'uuid',
      author_id: 'uuid',
      body: 'text',
      pinned: 'bool',
      created_at: 'time',
      retired_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'created_at desc',
  },
  notebook_proposals: {
    columns: {
      id: 'uuid',
      voyage_id: 'uuid',
      agent_id: 'uuid',
      op: 'text',
      entry_id: 'uuid',
      body: 'text',
      pinned: 'bool',
      rationale: 'text',
      status: 'text',
      created_at: 'time',
      decided_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'created_at desc',
  },
  charter_proposals: {
    columns: {
      id: 'uuid',
      voyage_id: 'uuid',
      agent_id: 'uuid',
      body: 'text',
      rationale: 'text',
      status: 'text',
      created_at: 'time',
      decided_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'created_at desc',
  },
  budget: {
    columns: {
      id: 'uuid',
      voyage_id: 'uuid',
      agent_id: 'uuid',
      limit_tokens: 'int',
      limit_usd: 'numeric',
      spent_tokens: 'int',
      spent_usd: 'numeric',
      updated_at: 'time',
    },
    scope: PROJECT_SCOPE,
    order: 'updated_at desc',
  },
} as const satisfies Record<string, ReadTable>;

export type ReadTableName = keyof typeof READ_TABLES;

export const READ_TABLE_NAMES = Object.keys(READ_TABLES) as [
  ReadTableName,
  ...ReadTableName[],
];
