alter table events alter column id drop identity;

create sequence events_id_seq as bigint owned by events.id;

select setval(
  'events_id_seq',
  coalesce((select max(id) from events), 0) + 1,
  false
);

create function order_event() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(
    hashtext('quarterdeck_events'),
    hashtext(new.project_id::text)
  );
  new.id := nextval('events_id_seq');
  return new;
end;
$$;

create trigger events_order before insert on events
  for each row execute function order_event();
