import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0153",
    name: "imputation_credit_account",
    sql: `
-- The imputation credit account (examples ITX25-ITX29, decision 548): typed
-- entries. Income tax paid comes from income_tax_payments. Nothing posts.
create table ica_entries (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  entry_date date not null,
  kind text not null check (kind in ('opening', 'dividend_paid', 'dividend_received', 'rwt_deducted', 'refund', 'other_credit', 'other_debit')),
  -- Credits positive, debits negative; an opening balance either way.
  amount numeric(18, 2) not null check (amount <> 0 or kind = 'opening'),
  check (kind = 'opening' or (kind in ('dividend_paid', 'refund', 'other_debit')) = (amount < 0)),
  dividend_amount numeric(18, 2) check (dividend_amount is null or dividend_amount > 0),
  check ((kind = 'dividend_paid') = (dividend_amount is not null)),
  description text check (description is null or length(description) <= 200),
  created_by_email text,
  created_at timestamptz not null default now()
);
create unique index ica_entries_one_opening on ica_entries ((kind)) where kind = 'opening';
create index ica_entries_date_idx on ica_entries (entry_date);
`,
  };
