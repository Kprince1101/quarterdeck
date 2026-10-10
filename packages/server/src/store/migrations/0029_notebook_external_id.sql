alter table notebook add column external_id text
  check (external_id is null or length(trim(external_id)) > 0);

create unique index notebook_project_external_id
  on notebook (project_id, external_id);
