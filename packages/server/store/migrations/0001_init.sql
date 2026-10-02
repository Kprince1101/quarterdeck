create table projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  repo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table rounds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  number integer not null check (number > 0),
  status text not null default 'planning'
    check (status in ('planning', 'active', 'ended')),
  goal text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (project_id, number)
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  round_id uuid references rounds (id) on delete set null,
  name text not null,
  role text not null
    check (role in ('planner', 'driver', 'builder', 'reviewer')),
  runtime text not null default 'kiro'
    check (runtime in ('kiro', 'claude', 'gemini')),
  status text not null default 'starting'
    check (status in ('starting', 'idle', 'working', 'paused', 'stuck', 'ended', 'killed', 'retired')),
  session_id text,
  worktree_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);

create index agents_project_status on agents (project_id, status);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  round_id uuid references rounds (id) on delete set null,
  assignee_id uuid references agents (id) on delete set null,
  title text not null,
  body text not null default '',
  status text not null default 'open'
    check (status in ('open', 'assigned', 'in_progress', 'in_review', 'bounced', 'done', 'cancelled')),
  depends_on uuid[] not null default '{}',
  source text not null default 'local',
  external_id text,
  pr_url text,
  head_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, source, external_id)
);

create index tickets_project_status on tickets (project_id, status);

create table cards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  agent_id uuid references agents (id) on delete set null,
  ticket_id uuid references tickets (id) on delete set null,
  kind text not null,
  question text not null,
  options jsonb not null default '[]',
  status text not null default 'open'
    check (status in ('open', 'answered', 'declined', 'expired')),
  answer text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index cards_project_status on cards (project_id, status);

create table turns (
  id bigint generated always as identity primary key,
  agent_id uuid not null references agents (id) on delete cascade,
  ticket_id uuid references tickets (id) on delete set null,
  seq integer not null check (seq > 0),
  prompt text not null,
  stop_reason text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  transcript_path text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (agent_id, seq)
);

create table events (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects (id) on delete cascade,
  agent_id uuid references agents (id) on delete set null,
  ticket_id uuid references tickets (id) on delete set null,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index events_project_id on events (project_id, id);

create function notify_event() returns trigger language plpgsql as $$
begin
  perform pg_notify(
    'quarterdeck_events',
    json_build_object('id', new.id, 'project_id', new.project_id, 'kind', new.kind)::text
  );
  return new;
end;
$$;

create trigger events_notify after insert on events
  for each row execute function notify_event();

create table notebook (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  round_id uuid references rounds (id) on delete set null,
  author_id uuid references agents (id) on delete set null,
  body text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

create index notebook_project_created on notebook (project_id, created_at);

create table charter_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  agent_id uuid references agents (id) on delete set null,
  body text not null,
  rationale text not null default '',
  status text not null default 'open'
    check (status in ('open', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table budget (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  round_id uuid references rounds (id) on delete cascade,
  agent_id uuid references agents (id) on delete cascade,
  limit_tokens bigint check (limit_tokens >= 0),
  limit_usd numeric(12, 4) check (limit_usd >= 0),
  spent_tokens bigint not null default 0 check (spent_tokens >= 0),
  spent_usd numeric(12, 4) not null default 0 check (spent_usd >= 0),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (project_id, round_id, agent_id)
);

create table layouts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects (id) on delete cascade,
  name text not null,
  is_preset boolean not null default false,
  spec jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (project_id, name)
);
