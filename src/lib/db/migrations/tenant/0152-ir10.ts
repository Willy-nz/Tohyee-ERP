import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0152",
    name: "ir10",
    sql: `
-- The IR10 financial statements summary from the books (examples
-- ITX19-ITX24, decision 547): each account's IR10 box and role. An account
-- without a row uses the default worked out in code.
create table account_ir10 (
  account_id bigint primary key references accounts(id),
  box integer not null check (box between 2 and 51),
  role text check (role in ('drawings', 'dividends_paid', 'current_account')),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
alter table income_tax_years add column multiple_activity boolean not null default false;
`,
  };
