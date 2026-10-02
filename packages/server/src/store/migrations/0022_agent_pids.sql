alter table agents
  add column pid integer check (pid > 0),
  add column pid_started_at timestamptz,
  add constraint agents_pid_started
    check ((pid is null) = (pid_started_at is null));

create index agents_pid on agents (project_id) where pid is not null;

alter table tickets drop constraint tickets_status_check;

alter table tickets add constraint tickets_status_check
  check (status in (
    'proposed', 'open', 'assigned', 'in_progress', 'in_review', 'bounced',
    'blocked', 'done', 'cancelled', 'rejected'
  ));
