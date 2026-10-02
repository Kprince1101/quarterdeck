create table intents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null,
  input jsonb not null,
  status text not null
    check (status in ('pending', 'applied', 'rejected')),
  result jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((status = 'pending') = (settled_at is null))
);

create index intents_pending on intents (project_id, created_at)
  where status = 'pending';
