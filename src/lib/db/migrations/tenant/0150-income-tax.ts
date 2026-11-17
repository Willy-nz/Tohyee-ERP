import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0150",
    name: "income_tax",
    sql: `
-- Income tax, stage 1 (examples ITX1-ITX10, decision 545). Nothing here
-- posts to the ledger. Figures typed from IRD are kept as typed, with who
-- typed them.
create table income_tax_settings (
  id boolean primary key default true check (id),
  taxpayer_type text check (taxpayer_type in ('company', 'individual')),
  agent_extension boolean not null default false,
  version integer not null default 1,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into income_tax_settings (id) values (true);

-- How an income or expense account counts for income tax (ITX2). An account
-- without a row counts in full (7040's default is worked out in code).
create table account_tax_treatments (
  account_id bigint primary key references accounts(id),
  treatment text not null check (treatment in ('full', 'not_deductible', 'entertainment_50', 'business_use', 'not_taxable')),
  business_use_percent numeric check (business_use_percent is null or (business_use_percent >= 0 and business_use_percent < 100 and scale(business_use_percent) <= 2)),
  check ((treatment = 'business_use') = (business_use_percent is not null)),
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- What IRD has for an income year, typed in.
create table income_tax_years (
  income_year integer primary key check (income_year between 2000 and 2100),
  assessed_rit numeric(18, 2) check (assessed_rit is null or assessed_rit >= 0),
  return_filed_on date,
  check ((assessed_rit is null) = (return_filed_on is null)),
  losses_brought_forward numeric(18, 2) not null default 0 check (losses_brought_forward >= 0),
  tax_credits numeric(18, 2) not null default 0 check (tax_credits >= 0),
  other_income numeric(18, 2) not null default 0,
  version integer not null default 1,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- Typed adjustments to taxable income (positive adds).
create table income_tax_adjustments (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  income_year integer not null check (income_year between 2000 and 2100),
  description text not null check (length(description) between 1 and 200),
  amount numeric(18, 2) not null check (amount <> 0),
  created_by_email text,
  created_at timestamptz not null default now()
);
create index income_tax_adjustments_year_idx on income_tax_adjustments (income_year);

-- Payments to IRD towards an income year's tax, typed in.
create table income_tax_payments (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  income_year integer not null check (income_year between 2000 and 2100),
  paid_on date not null,
  amount numeric(18, 2) not null check (amount > 0),
  note text check (note is null or length(note) <= 200),
  created_by_email text,
  created_at timestamptz not null default now()
);
create index income_tax_payments_year_idx on income_tax_payments (income_year);
`,
  };
