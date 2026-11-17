import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0102",
    name: "intercompany_and_ecb_rates",
    sql: `
-- Consolidation (CO2, decisions 437-445): accounts that hold amounts with
-- another organisation in a consolidation group (NetSuite's "Eliminate
-- Intercompany Transactions"), and the contact that stands for another
-- group organisation, by its id on this server.
create table intercompany_accounts (
  account_id bigint primary key references accounts(id),
  counterpart_organisation_id text not null check (length(counterpart_organisation_id) between 1 and 100),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
create table intercompany_contacts (
  contact_id bigint primary key references contacts(id),
  counterpart_organisation_id text not null check (length(counterpart_organisation_id) between 1 and 100),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
create unique index intercompany_contacts_one_per_organisation on intercompany_contacts (counterpart_organisation_id);

-- Daily rates from the European Central Bank into the exchange rates list
-- (FX1, decision 437).
create table ecb_rate_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  enabled_on date,
  -- Currencies to bring in besides those the organisation already uses (e.g. a consolidation member's).
  extra_currencies text[] not null default '{}',
  last_run_at timestamptz,
  last_rates_date date,
  last_error text,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into ecb_rate_settings (id) values (true);
`,
  };
