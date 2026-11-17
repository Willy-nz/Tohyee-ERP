import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0155",
    name: "income_tax_payments_from_books",
    sql: `
-- IRD payments picked from the books (examples ITX36-ITX40, decision 550):
-- the accounts income tax payments are coded to, and which journal line a
-- payment came from, so it can't be counted twice.
create table income_tax_payment_accounts (
  account_id bigint primary key references accounts(id),
  added_by_email text,
  added_at timestamptz not null default now()
);
alter table income_tax_payments add column journal_line_id bigint unique references ledger_journal_lines(id);
`,
  };
