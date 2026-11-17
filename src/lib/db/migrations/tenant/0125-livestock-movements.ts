import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0125",
    name: "livestock_movements",
    sql: `
-- Livestock (#221 stage 2; examples LV1-LV3 approved by Jess 11 Oct 2026,
-- decision 503). Head counts only: nothing here posts. Classes are the codes
-- in src/lib/livestock/classes.ts (IRD's NAMV classes for dairy cattle, beef
-- cattle and sheep).
create table livestock_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- The first income year recorded in Tohyee: its opening comes from last year's workpaper.
  first_year_start date,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into livestock_settings (id) values (true);

create table livestock_locations (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index livestock_locations_name on livestock_locations (lower(name));

-- The opening position of the first year, by class, from last year's workpaper (decision 503).
create table livestock_openings (
  kind text not null,
  class_code text not null,
  head integer not null check (head >= 0),
  value numeric(18, 2) not null check (value >= 0),
  primary key (kind, class_code)
);

-- Ageing is worked out, not run: at the start of each income year, every
-- class's closing head moves to the next class (LV1), so it can't happen
-- twice and a late entry in an earlier year flows through. Only mixed-age
-- ewes move in part: how many turn rising five is said here, per year.
create table livestock_ageing_splits (
  year_start date not null,
  kind text not null,
  class_code text not null,
  head integer not null check (head >= 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (year_start, kind, class_code)
);

create table livestock_movements (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  movement_date date not null,
  movement_type text not null check (movement_type in (
    'birth', 'purchase', 'sale', 'death', 'missing', 'found', 'reclass', 'transfer', 'arrival', 'departure')),
  -- Stock held for someone else is shown but never counted as the farm's or valued (LV3).
  ownership text not null default 'owned' check (ownership in ('owned', 'held_for_others')),
  held_for text check (held_for is null or length(held_for) between 1 and 200),
  kind text not null,
  class_code text not null,
  to_class_code text,
  head integer not null check (head > 0),
  -- Purchases and sales: the amount excluding GST, when known.
  amount numeric(18, 2) check (amount is null or amount >= 0),
  location_id bigint references livestock_locations(id),
  to_location_id bigint references livestock_locations(id),
  -- No foreign keys to document lines: those tables guard against truncation (append-only), and a key would block it differently.
  sales_invoice_line_id bigint,
  bill_line_id bigint,
  note text check (note is null or length(note) <= 1000),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_email text,
  void_reason text,
  unique (command_source, idempotency_key),
  check ((ownership = 'held_for_others') = (movement_type in ('arrival', 'departure'))),
  check ((ownership = 'held_for_others') = (held_for is not null)),
  check ((movement_type = 'reclass') = (to_class_code is not null)),
  check ((movement_type = 'transfer') = (to_location_id is not null)),
  check (movement_type in ('purchase', 'sale') or (amount is null and sales_invoice_line_id is null and bill_line_id is null)),
  check (sales_invoice_line_id is null or movement_type = 'sale'),
  check (bill_line_id is null or movement_type = 'purchase')
);
create index livestock_movements_date on livestock_movements (movement_date, id);
-- A document line is linked once per class (LV7: a sale is never counted twice).
create unique index livestock_movements_invoice_line on livestock_movements (sales_invoice_line_id, class_code)
  where sales_invoice_line_id is not null and voided_at is null;
create unique index livestock_movements_bill_line on livestock_movements (bill_line_id, class_code)
  where bill_line_id is not null and voided_at is null;

-- What the farmer counted at a date (LV2). The newest count for a date and class counts.
create table livestock_counts (
  id bigserial primary key,
  count_date date not null,
  kind text not null,
  class_code text not null,
  head integer not null check (head >= 0),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index livestock_counts_date on livestock_counts (count_date, kind, class_code, id desc);
`,
  };
