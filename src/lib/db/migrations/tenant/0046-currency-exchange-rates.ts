import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0046",
    name: "currency_exchange_rates",
    sql: `
-- The currency exchange rates list (examples MC46-MC53), like NetSuite's
-- Currency Exchange Rates: rates for each foreign currency, each with the
-- date it takes effect, in the base currency per 1 unit (the direction of
-- every other exchange_rate column). A new foreign-currency document takes
-- the latest entry effective on or before its date. Entries are never
-- changed or deleted: a correction is a newer entry, or archiving the wrong
-- one. One command (a single rate or a pasted list) shares an idempotency
-- key, one row per line.
create table currency_exchange_rates (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  line_number integer not null check (line_number between 1 and 500),
  request_hash text not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  effective_date date not null,
  rate numeric not null check (rate > 0 and scale(rate) <= 8),
  note text check (note is null or length(note) between 1 and 200),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by_user_id uuid,
  archived_by_email text,
  unique (command_source, idempotency_key, line_number),
  check (archived_at is not null or (archived_by_user_id is null and archived_by_email is null))
);
create index currency_exchange_rates_lookup_idx
  on currency_exchange_rates (currency_code, effective_date desc, created_at desc, id desc) where archived_at is null;

create function tohyee_guard_currency_exchange_rate() returns trigger
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
    -- Archiving is the only change: once, and nothing else about the entry.
    if old.archived_at is null and new.archived_at is not null
       and (new.id, new.command_source, new.idempotency_key, new.line_number, new.request_hash, new.currency_code,
            new.effective_date, new.rate, new.note, new.created_by_user_id, new.created_by_email, new.created_at)
           is not distinct from
           (old.id, old.command_source, old.idempotency_key, old.line_number, old.request_hash, old.currency_code,
            old.effective_date, old.rate, old.note, old.created_by_user_id, old.created_by_email, old.created_at) then
      return new;
    end if;
    raise exception 'Exchange rates can''t be changed; add a newer entry or archive this one' using errcode = 'P0001';
  end if;
  raise exception 'Exchange rates can''t be deleted; archive them instead' using errcode = 'P0001';
end;
$$;
create trigger currency_exchange_rates_guard before insert or update or delete on currency_exchange_rates
  for each row execute function tohyee_guard_currency_exchange_rate();
create trigger currency_exchange_rates_no_truncate before truncate on currency_exchange_rates
  for each statement execute function tohyee_guard_currency_exchange_rate();
`,
  };
