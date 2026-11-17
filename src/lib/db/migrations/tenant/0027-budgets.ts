import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0027",
    name: "budgets",
    sql: `
-- Budgets (examples BU1-BU8): an overall budget, which every organisation
-- has and can't archive, and named budgets, optionally for one tracking
-- value. Each holds an amount per profit and loss account per month, in the
-- account's natural direction. Budgets post nothing. They're archived, never
-- deleted; every change of amounts is in audit_events with the old and new
-- amounts.
create table budgets (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  is_overall boolean not null default false,
  tracking_value_id bigint references tracking_values(id),
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  archived_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((archived_at is null) = (archived_by_email is null)),
  check (not is_overall or (tracking_value_id is null and archived_at is null))
);
create unique index budgets_one_overall on budgets (is_overall) where is_overall;
create unique index budgets_name_key on budgets (lower(name)) where archived_at is null;

create function tohyee_guard_budget() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'budgets can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Budgets can''t be deleted, only archived' using errcode = 'P0001';
  end if;
  if new.is_overall <> old.is_overall or new.tracking_value_id is distinct from old.tracking_value_id then
    raise exception 'A budget''s tracking value and whether it''s the overall budget never change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger budgets_guard
  before update or delete on budgets
  for each row execute function tohyee_guard_budget();
create trigger budgets_no_truncate
  before truncate on budgets
  for each statement execute function tohyee_guard_budget();

create table budget_amounts (
  budget_id bigint not null references budgets(id),
  account_id bigint not null references accounts(id),
  month date not null check (extract(day from month) = 1),
  amount numeric not null check (scale(amount) <= 4),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (budget_id, account_id, month)
);

-- Amounts are only for profit and loss accounts, can't be changed on an
-- archived budget, and are never deleted (an amount is set to 0.00 instead).
create function tohyee_guard_budget_amount() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'budget_amounts can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Budget amounts can''t be deleted; set them to 0.00' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and (new.budget_id <> old.budget_id or new.account_id <> old.account_id or new.month <> old.month) then
    raise exception 'A budget amount''s budget, account and month never change' using errcode = 'P0001';
  end if;
  if not exists (select 1 from accounts where id = new.account_id and account_class in ('revenue', 'expense')) then
    raise exception 'Budgets hold profit and loss accounts only' using errcode = 'P0001';
  end if;
  if exists (select 1 from budgets where id = new.budget_id and archived_at is not null) then
    raise exception 'This budget is archived, so its amounts can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger budget_amounts_guard
  before insert or update or delete on budget_amounts
  for each row execute function tohyee_guard_budget_amount();
create trigger budget_amounts_no_truncate
  before truncate on budget_amounts
  for each statement execute function tohyee_guard_budget_amount();

-- Every organisation has an overall budget, like Xero's.
insert into budgets (command_source, idempotency_key, request_hash, name, is_overall)
values ('system', 'overall-budget', 'overall-budget', 'Overall budget', true);
`,
  };
