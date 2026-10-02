alter table agents
  add column pid integer check (pid > 0),
  add column pid_started_at timestamptz,
  add constraint agents_pid_started
    check ((pid is null) = (pid_started_at is null));

create index agents_pid on agents (project_id) where pid is not null;
