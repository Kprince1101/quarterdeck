alter table projects add column archived_at timestamptz;

create unique index agents_live_name on agents (project_id, name)
  where status <> 'retired';
