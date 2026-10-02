create function notify_change() returns trigger language plpgsql as $$
declare
  changed jsonb;
  project text;
begin
  if tg_op = 'DELETE' then
    changed := to_jsonb(old);
  else
    changed := to_jsonb(new);
  end if;
  project := case tg_table_name
    when 'projects' then changed ->> 'id'
    when 'turns' then (
      select a.project_id::text from agents a
      where a.id = (changed ->> 'agent_id')::uuid
    )
    else changed ->> 'project_id'
  end;
  perform pg_notify(
    'quarterdeck_changes',
    json_build_object(
      'table', tg_table_name,
      'op', lower(tg_op),
      'id', changed -> 'id',
      'project_id', project
    )::text
  );
  return null;
end;
$$;

create trigger projects_change after insert or update or delete on projects
  for each row execute function notify_change();

create trigger rounds_change after insert or update or delete on rounds
  for each row execute function notify_change();

create trigger agents_change after insert or update or delete on agents
  for each row execute function notify_change();

create trigger tickets_change after insert or update or delete on tickets
  for each row execute function notify_change();

create trigger cards_change after insert or update or delete on cards
  for each row execute function notify_change();

create trigger turns_change after insert or update or delete on turns
  for each row execute function notify_change();

create trigger notebook_change after insert or update or delete on notebook
  for each row execute function notify_change();

create trigger charter_proposals_change after insert or update or delete on charter_proposals
  for each row execute function notify_change();

create trigger budget_change after insert or update or delete on budget
  for each row execute function notify_change();

create trigger layouts_change after insert or update or delete on layouts
  for each row execute function notify_change();
