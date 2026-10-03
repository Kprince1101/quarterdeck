alter table projects add column tracker jsonb
  check (tracker is null or jsonb_typeof(tracker) = 'object');
alter table projects add column publishes boolean;

alter table tickets add column external_ref text
  check (external_ref is null or length(trim(external_ref)) > 0);
