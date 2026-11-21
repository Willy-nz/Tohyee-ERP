import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0299",
    name: "fuel_refund",
    sql: `
-- The fuel excise refund (examples FUEL1-FUEL12). Working figures for NZTA's
-- MR70 claim; nothing here posts to the ledger.

-- What uses petrol on the farm (FUEL6).
create table fuel_refund_users (
  id bigserial primary key,
  name text not null check (length(btrim(name)) between 1 and 100),
  kind text not null check (kind ~ '^[a-z_]{2,40}$'),
  -- Licensed for general use on the road and not an exempted farm vehicle: its share isn't claimed.
  road_licensed boolean not null default false,
  is_active boolean not null default true,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- A quarter's tank figures (FUEL5); null opening is last quarter's closing.
create table fuel_refund_quarters (
  quarter_end date primary key check (to_char(quarter_end, 'MM-DD') in ('03-31', '06-30', '09-30', '12-31')),
  opening_litres numeric(12, 2) check (opening_litres >= 0),
  closing_litres numeric(12, 2) check (closing_litres >= 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- Each user's share of a quarter's petrol, in per cent (FUEL6).
create table fuel_refund_shares (
  quarter_end date not null,
  user_id bigint not null references fuel_refund_users(id),
  percent numeric(5, 2) not null check (percent >= 0 and percent <= 100),
  primary key (quarter_end, user_id)
);

-- What the farmer says a line from the books is, and its litres (FUEL2, FUEL3).
create table fuel_refund_line_choices (
  source text not null check (source in ('bill_line', 'bank_line')),
  source_id bigint not null,
  fuel_type text not null check (fuel_type in ('petrol', 'diesel', 'unsure', 'not_fuel')),
  litres numeric(12, 2) check (litres > 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (source, source_id)
);

-- Petrol or diesel added by hand (FUEL4).
create table fuel_refund_manual (
  id bigserial primary key,
  bought_on date not null,
  description text not null check (length(btrim(description)) between 1 and 200),
  fuel_type text not null check (fuel_type in ('petrol', 'diesel')),
  litres numeric(12, 2) not null check (litres > 0),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index fuel_refund_manual_date on fuel_refund_manual (bought_on);
`,
};
