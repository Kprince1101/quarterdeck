alter table notebook add column retired_at timestamptz;

alter table charter_proposals
  add column round_id uuid references rounds (id) on delete set null;

create table notebook_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  round_id uuid references rounds (id) on delete set null,
  agent_id uuid references agents (id) on delete set null,
  op text not null check (op in ('add', 'update', 'retire')),
  entry_id uuid references notebook (id) on delete cascade,
  body text,
  pinned boolean not null default false,
  rationale text not null default '',
  status text not null default 'open'
    check (status in ('open', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check ((op = 'add') = (entry_id is null)),
  check ((op = 'retire') = (body is null)),
  check ((status = 'open') = (decided_at is null))
);

create index notebook_proposals_project_status
  on notebook_proposals (project_id, status);

create trigger notebook_proposals_change
  after insert or update or delete on notebook_proposals
  for each row execute function notify_change();
