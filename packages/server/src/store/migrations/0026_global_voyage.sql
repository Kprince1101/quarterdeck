alter table voyages add column projects text[] not null default '{}';

alter table notebook alter column project_id drop not null;

alter table notebook_proposals add column global boolean not null default false;
