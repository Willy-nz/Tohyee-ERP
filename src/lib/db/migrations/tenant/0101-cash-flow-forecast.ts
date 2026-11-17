import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0101",
    name: "cash_flow_forecast",
    sql: `
-- Cash flow forecast (CF1-CF9, decisions 432-436), like NetSuite's Cash 360.
-- The forecast itself is worked out from the books each time; these hold
-- only what people add: forecast items (Cash 360's additional values) and
-- the accounts forecast from their average (Cash 360's account categories).
create table cash_flow_items (
  id bigserial primary key,
  direction text not null check (direction in ('in', 'out')),
  description text not null check (length(description) between 1 and 200 and description = btrim(description)),
  amount numeric not null check (amount > 0),
  item_date date not null,
  repeat text not null default 'none' check (repeat in ('none', 'week', 'month')),
  until_date date,
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  archived_by_email text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  check (repeat <> 'none' or until_date is null),
  check (until_date is null or until_date >= item_date),
  check ((archived_at is null) = (archived_by_email is null))
);

create table cash_flow_account_averages (
  account_id bigint primary key references accounts(id),
  direction text not null check (direction in ('in', 'out')),
  months integer not null check (months in (3, 6)),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  };
