alter table rounds rename to voyages;
alter table voyages rename constraint rounds_pkey to voyages_pkey;
alter table voyages rename constraint rounds_project_id_fkey to voyages_project_id_fkey;
alter table voyages rename constraint rounds_project_id_number_key to voyages_project_id_number_key;
alter table voyages rename constraint rounds_number_check to voyages_number_check;
alter table voyages rename constraint rounds_status_check to voyages_status_check;
alter trigger rounds_change on voyages rename to voyages_change;

alter table agents rename column round_id to voyage_id;
alter table agents rename constraint agents_round_id_fkey to agents_voyage_id_fkey;

alter table tickets rename column round_id to voyage_id;
alter table tickets rename constraint tickets_round_id_fkey to tickets_voyage_id_fkey;

alter table notebook rename column round_id to voyage_id;
alter table notebook rename constraint notebook_round_id_fkey to notebook_voyage_id_fkey;

alter table budget rename column round_id to voyage_id;
alter table budget rename constraint budget_round_id_fkey to budget_voyage_id_fkey;
alter table budget rename constraint budget_project_id_round_id_agent_id_key
  to budget_project_id_voyage_id_agent_id_key;

alter table charter_proposals rename column round_id to voyage_id;
alter table charter_proposals rename constraint charter_proposals_round_id_fkey
  to charter_proposals_voyage_id_fkey;

alter table notebook_proposals rename column round_id to voyage_id;
alter table notebook_proposals rename constraint notebook_proposals_round_id_fkey
  to notebook_proposals_voyage_id_fkey;

create function voyage_keys(value jsonb) returns jsonb language sql immutable as $$
  select case
    when value is null or jsonb_typeof(value) <> 'object' then value
    else (value - 'roundId' - 'round')
      || case when value ? 'roundId'
           then jsonb_build_object('voyageId', value -> 'roundId')
           else '{}'::jsonb end
      || case when value ? 'round'
           then jsonb_build_object('voyage', value -> 'round')
           else '{}'::jsonb end
  end
$$;

update events set kind = case kind
    when 'driver.round_started' then 'driver.voyage_started'
    else 'voyage.' || substr(kind, length('round.') + 1)
  end
  where kind = 'driver.round_started' or kind like 'round.%';

update events set payload = voyage_keys(payload)
  where jsonb_typeof(payload) = 'object'
    and (payload ? 'roundId' or payload ? 'round');

update events set payload = jsonb_set(payload, '{service}', '"voyages"')
  where kind = 'crew.failed' and payload ->> 'service' = 'rounds';

update intents set kind = 'voyage.' || substr(kind, length('round.') + 1)
  where kind like 'round.%';

update intents set input = voyage_keys(input), result = voyage_keys(result)
  where (jsonb_typeof(input) = 'object'
         and (input ? 'roundId' or input ? 'round'))
     or (jsonb_typeof(result) = 'object'
         and (result ? 'roundId' or result ? 'round'));

drop function voyage_keys(jsonb);
