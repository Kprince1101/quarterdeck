alter table cards
  add column checked text,
  add column recommendation text,
  add column expires_at timestamptz;
