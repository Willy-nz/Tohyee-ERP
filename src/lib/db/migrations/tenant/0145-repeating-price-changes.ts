import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0145",
    name: "repeating_price_changes",
    sql: `
-- Price changes on repeating invoices (examples RP1-RP8, decision 535): a
-- rise or fall saved once for many templates, made on the templates from a
-- date. Templates post nothing, so neither do these.
create table repeating_price_changes (
  id bigserial primary key,
  method text not null check (method in ('percent', 'fixed')),
  percent numeric(9, 2),
  fixed_price numeric(18, 4),
  item_id bigint references items(id),
  rounding text not null default 'cent' check (rounding in ('cent', '0.50', '1', '5', '10')),
  minimum_increase numeric(18, 2),
  effective_date date not null,
  note text check (note is null or length(note) <= 500),
  status text not null default 'saved' check (status in ('saved', 'cancelled', 'undone')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  ended_by_email text,
  ended_at timestamptz,
  check ((method = 'percent') = (percent is not null)),
  check ((method = 'fixed') = (fixed_price is not null and item_id is not null)),
  check ((status = 'saved') = (ended_at is null))
);

-- One row per template line the change covers: its old and new unit price,
-- and whether it has been made on the template yet.
create table repeating_price_change_lines (
  id bigserial primary key,
  price_change_id bigint not null references repeating_price_changes(id),
  repeating_invoice_id bigint not null references repeating_invoices(id),
  line_order integer not null,
  description text not null,
  old_unit_price numeric(18, 4) not null,
  new_unit_price numeric(18, 4) not null,
  status text not null default 'waiting' check (status in ('waiting', 'made', 'skipped', 'cancelled', 'undone', 'kept')),
  message text,
  done_at timestamptz,
  unique (price_change_id, repeating_invoice_id, line_order)
);
create index repeating_price_change_lines_waiting on repeating_price_change_lines (repeating_invoice_id) where status = 'waiting';
`,
  };
