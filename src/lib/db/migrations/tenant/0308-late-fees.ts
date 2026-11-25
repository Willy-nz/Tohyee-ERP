import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0308",
  name: "late_fees",
  sql: `
-- Late payment fees and interest (LATE1-LATE12): off until an admin turns
-- them on. One row of settings.
create table late_fee_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- A flat fee before GST, charged once on each overdue invoice; null for none.
  fee_amount numeric(18, 2) check (fee_amount is null or fee_amount > 0),
  -- Simple interest, percent a year; null for none.
  interest_rate numeric(9, 4) check (interest_rate is null or (interest_rate > 0 and interest_rate <= 100)),
  grace_days integer not null default 0 check (grace_days between 0 and 365),
  minimum_overdue numeric(18, 2) not null default 0 check (minimum_overdue >= 0),
  fee_account_id bigint references accounts(id),
  interest_account_id bigint references accounts(id),
  approve boolean not null default false,
  monthly boolean not null default false,
  -- The 1st of the month the monthly run last ran for (LATE10).
  last_monthly_run date,
  updated_at timestamptz not null default now(),
  updated_by_email text
);

-- Customers who are never charged (LATE11).
create table late_fee_exclusions (
  contact_id bigint primary key references contacts(id),
  added_at timestamptz not null default now(),
  added_by_email text
);

-- What each late payment invoice charged, for which overdue invoice (LATE3).
-- A charge whose invoice is deleted goes with it; one whose invoice is voided
-- no longer counts (LATE9).
create table late_fee_charges (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id),
  charge_invoice_id bigint not null references sales_invoices(id) on delete cascade,
  kind text not null check (kind in ('fee', 'interest')),
  -- For interest: the days charged, from_date to to_date inclusive.
  from_date date,
  to_date date,
  rate numeric(9, 4),
  amount numeric(18, 2) not null,
  created_at timestamptz not null default now(),
  check ((kind = 'interest') = (from_date is not null and to_date is not null and rate is not null))
);
create index late_fee_charges_invoice on late_fee_charges (invoice_id);
create index late_fee_charges_charge_invoice on late_fee_charges (charge_invoice_id);
`,
};
