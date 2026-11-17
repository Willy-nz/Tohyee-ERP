import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0110",
    name: "exchange_rate_sources",
    sql: `
-- Where exchange rates come from (#183, examples FX2-FX9, decision 479):
-- the ECB's daily rates, uploaded rate sets, or typed only. The setting
-- lives with the ECB settings (the organisation's exchange rate settings).
-- Organisations already taking ECB rates keep them; the rest are typed only,
-- which is how they work today.
alter table ecb_rate_settings
  add column rate_source text not null default 'typed' check (rate_source in ('ecb', 'uploaded', 'typed'));
update ecb_rate_settings set rate_source = 'ecb' where enabled;

-- Each change of source, with the reason Inland Revenue asks you to keep (FX7).
create table exchange_rate_source_changes (
  id bigserial primary key,
  from_source text not null check (from_source in ('ecb', 'uploaded', 'typed')),
  to_source text not null check (to_source in ('ecb', 'uploaded', 'typed')),
  reason text check (reason is null or length(reason) between 1 and 500),
  changed_by_user_id uuid,
  changed_by_email text,
  changed_at timestamptz not null default now(),
  check (from_source <> to_source)
);

-- An uploaded set of rates for a period (FX3), named for where it came from
-- (IRD, RBNZ, a bank). Its rates are entries in the exchange rates list,
-- effective from the period's start and used only up to its end (FX5). A
-- set is never changed or deleted; a newer set for the same period replaces
-- it, with a reason, and the old set's rates are archived (FX6).
create table exchange_rate_sets (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100),
  period_start date not null,
  period_end date not null,
  quoted text not null check (quoted in ('foreign_per_base', 'base_per_foreign')),
  file_name text check (file_name is null or length(file_name) between 1 and 255),
  replaces_set_id bigint references exchange_rate_sets(id),
  replace_reason text check (replace_reason is null or length(replace_reason) between 1 and 500),
  replaced_at timestamptz,
  replaced_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (period_end >= period_start),
  check ((replaces_set_id is null) = (replace_reason is null))
);

create function tohyee_guard_exchange_rate_set() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.replaced_at is null and new.replaced_at is not null
     and (to_jsonb(new) - array['replaced_at', 'replaced_by_email']) = (to_jsonb(old) - array['replaced_at', 'replaced_by_email']) then
    return new;
  end if;
  raise exception 'Exchange rate sets can''t be changed or deleted; upload a set that replaces it' using errcode = 'P0001';
end;
$$;
create trigger exchange_rate_sets_guard before update or delete on exchange_rate_sets
  for each row execute function tohyee_guard_exchange_rate_set();
create trigger exchange_rate_sets_no_truncate before truncate on exchange_rate_sets
  for each statement execute function tohyee_guard_exchange_rate_set();

alter table currency_exchange_rates add column rate_set_id bigint references exchange_rate_sets(id);
create index currency_exchange_rates_set_idx on currency_exchange_rates (rate_set_id) where rate_set_id is not null;

-- Archiving is still the only change, and it can't move an entry between sets.
create or replace function tohyee_guard_currency_exchange_rate() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.currency_code = (select base_currency from organisation_settings where id = true) then
      raise exception 'Exchange rates are for foreign currencies, not %', new.currency_code using errcode = '23514';
    end if;
    if new.archived_at is not null then
      raise exception 'A new exchange rate can''t be archived already' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.archived_at is null and new.archived_at is not null
       and (to_jsonb(new) - array['archived_at', 'archived_by_user_id', 'archived_by_email'])
         = (to_jsonb(old) - array['archived_at', 'archived_by_user_id', 'archived_by_email']) then
      return new;
    end if;
    raise exception 'Exchange rates can''t be changed; add a newer entry or archive this one' using errcode = 'P0001';
  end if;
  raise exception 'Exchange rates can''t be deleted; archive them instead' using errcode = 'P0001';
end;
$$;

-- Where each foreign-currency document's rate came from (FX4): "Typed" when
-- typed on the document, else the list entry's source ("ECB", a set's name,
-- "Exchange rates list") or "Last rate used". Older documents have none.
alter table sales_invoices add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
alter table bills add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
alter table sales_credit_notes add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
alter table supplier_credit_notes add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
`,
  };
