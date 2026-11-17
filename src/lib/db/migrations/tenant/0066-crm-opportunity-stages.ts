import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0066",
    name: "crm_opportunity_stages",
    sql: `
-- Editable opportunity stages, probability, forecast categories, sales
-- processes and quotas (examples CRMS1-CRMS11, decisions 76-90), after
-- Salesforce's Stage picklist, Probability and Forecast Category fields,
-- sales processes and forecast quotas. The six fixed stages become the
-- organisation's starting stages and keep their keys, so saved
-- opportunities, the API and the history keep working.
create table crm_opportunity_stages (
  id bigserial primary key,
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text not null check (length(name) between 1 and 40 and name = btrim(name)),
  sort_order integer not null,
  stage_type text not null check (stage_type in ('open', 'won', 'lost')),
  probability integer not null check (probability between 0 and 100),
  forecast_category text not null check (forecast_category in ('pipeline', 'best_case', 'commit', 'closed', 'omitted')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stage_type <> 'won' or (probability = 100 and forecast_category = 'closed')),
  check (stage_type <> 'lost' or (probability = 0 and forecast_category = 'omitted')),
  check (stage_type <> 'open' or forecast_category <> 'closed')
);
create unique index crm_opportunity_stages_name_idx on crm_opportunity_stages (lower(name));

insert into crm_opportunity_stages (key, name, sort_order, stage_type, probability, forecast_category) values
  ('new', 'New', 1, 'open', 10, 'pipeline'),
  ('screening', 'Screening', 2, 'open', 20, 'pipeline'),
  ('meeting', 'Meeting', 3, 'open', 50, 'pipeline'),
  ('proposal', 'Proposal', 4, 'open', 75, 'pipeline'),
  ('won', 'Won', 5, 'won', 100, 'closed'),
  ('lost', 'Lost', 6, 'lost', 0, 'omitted');

-- Stages are archived, never deleted; a key never changes; a stage's type
-- can't change while opportunities are in it; and at least one active
-- stage of each type stays (CRMS3).
create function tohyee_guard_crm_opportunity_stage() returns trigger
language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Opportunity stages are never deleted; archive one instead' using errcode = 'P0001';
  end if;
  if new.key <> old.key then
    raise exception 'A stage''s key can''t change' using errcode = 'P0001';
  end if;
  if new.stage_type <> old.stage_type and exists (select 1 from crm_opportunities where stage = old.key) then
    raise exception '% has opportunities, so its type can''t change', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunity_stages_guard before update or delete on crm_opportunity_stages
  for each row execute function tohyee_guard_crm_opportunity_stage();
create trigger crm_opportunity_stages_no_truncate before truncate on crm_opportunity_stages
  for each statement execute function tohyee_guard_crm_opportunity_stage();

create function tohyee_crm_stages_each_type() returns trigger
language plpgsql as $$
declare
  missing text;
begin
  select t into missing from unnest(array['open', 'won', 'lost']) t
   where not exists (select 1 from crm_opportunity_stages s where s.stage_type = t and s.is_active) limit 1;
  if missing is not null then
    raise exception 'At least one active % stage must stay', case missing when 'open' then 'Open' when 'won' then 'Closed won' else 'Closed lost' end
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger crm_opportunity_stages_each_type after update on crm_opportunity_stages
  deferrable initially deferred for each row execute function tohyee_crm_stages_each_type();

-- Opportunities: the fixed list of stages becomes a reference to the
-- organisation's stages, and the "invoice only when won" check becomes
-- "invoice only in a Closed won stage" (CRMS4).
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'crm_opportunities'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%stage%' loop
    execute format('alter table crm_opportunities drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table crm_opportunities add constraint crm_opportunities_stage_fkey foreign key (stage) references crm_opportunity_stages (key);
create index crm_opportunities_stage_idx on crm_opportunities (stage);
create index crm_opportunities_close_date_idx on crm_opportunities (close_date);

-- Probability and forecast category start as the stage's (CRMS1).
alter table crm_opportunities add column probability integer check (probability between 0 and 100);
alter table crm_opportunities add column forecast_category text
  check (forecast_category in ('pipeline', 'best_case', 'commit', 'closed', 'omitted'));
update crm_opportunities o set probability = s.probability, forecast_category = s.forecast_category
  from crm_opportunity_stages s where s.key = o.stage;
alter table crm_opportunities alter column probability set not null;
alter table crm_opportunities alter column forecast_category set not null;

-- A won opportunity is 100% Closed, a lost one 0% Omitted, an open one never
-- Closed, and only a won one has an invoice (CRMS4, CRMS5). Missing values
-- come from the stage.
create function tohyee_crm_opportunity_stage_rules() returns trigger
language plpgsql as $$
declare
  s crm_opportunity_stages;
begin
  select * into s from crm_opportunity_stages where key = new.stage;
  if not found then
    raise exception 'There''s no stage called %', new.stage using errcode = 'P0001';
  end if;
  if new.probability is null then new.probability := s.probability; end if;
  if new.forecast_category is null then new.forecast_category := s.forecast_category; end if;
  if s.stage_type = 'won' and (new.probability <> 100 or new.forecast_category <> 'closed') then
    raise exception 'A won opportunity is 100%% and in the Closed forecast category' using errcode = 'P0001';
  end if;
  if s.stage_type = 'lost' and (new.probability <> 0 or new.forecast_category <> 'omitted') then
    raise exception 'A lost opportunity is 0%% and in the Omitted forecast category' using errcode = 'P0001';
  end if;
  if s.stage_type = 'open' and new.forecast_category = 'closed' then
    raise exception 'Only a won opportunity can be in the Closed forecast category' using errcode = 'P0001';
  end if;
  if new.invoice_id is not null and s.stage_type <> 'won' then
    raise exception 'Only a won opportunity can have an invoice' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_stage_rules before insert or update of stage, probability, forecast_category, invoice_id on crm_opportunities
  for each row execute function tohyee_crm_opportunity_stage_rules();

-- Once an opportunity has made an invoice it keeps that invoice and its
-- stage, whatever the stage is called now.
create or replace function tohyee_guard_crm_opportunity() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.invoice_id is distinct from old.invoice_id or new.stage is distinct from old.stage) then
    raise exception 'This opportunity has made an invoice, so its stage can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Sales processes (CRMS7): the stages an opportunity record type uses, in
-- the stages' own order; null means every active stage.
alter table crm_record_types add column stage_keys text[];
alter table crm_record_types add constraint crm_record_types_stage_keys_check
  check (stage_keys is null or (record = 'opportunity' and cardinality(stage_keys) between 3 and 100));

-- Quotas (CRMS10): per owner per month, in the base currency.
create table crm_forecast_quotas (
  id bigserial primary key,
  owner_user_id text not null check (length(owner_user_id) between 1 and 200),
  month date not null check (extract(day from month) = 1),
  amount numeric(20, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, month)
);
`,
  };
