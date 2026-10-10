alter table cards add column attachments jsonb not null default '[]'::jsonb
  check (jsonb_typeof(attachments) = 'array');
