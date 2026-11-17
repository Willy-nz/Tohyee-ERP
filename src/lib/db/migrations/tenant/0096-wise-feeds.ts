import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0096",
    name: "wise_feeds",
    sql: `
-- Wise as a bank feed (WI1-WI10, decisions 400-403): the organisation's own
-- Wise business account, read with a personal API token (not read-only),
-- encrypted with the server's TOHYEE_SECRET_KEY and cleared on disconnect.
create table wise_connections (
  id bigserial primary key,
  token_ciphertext text,
  profile_id bigint not null,
  profile_name text check (profile_name is null or length(profile_name) <= 200),
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- The profile's standard balances when last read: [{id, currency, amount}].
  balances jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null)),
  check (status = 'removed' or token_ciphertext is not null)
);
create unique index wise_connections_one_active on wise_connections ((true)) where status = 'active';

-- A Wise currency balance linked to a bank account in that currency.
create table wise_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references wise_connections(id),
  balance_id bigint not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  start_date date not null,
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or connection_id is not null)
);
create unique index wise_links_currency_once on wise_links (currency_code) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check
  check (source in ('file', 'akahu', 'simplefin', 'stripe', 'paypal', 'wise'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin', 'stripe', 'paypal', 'wise'));
`,
  };
