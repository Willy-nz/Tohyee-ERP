import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0094",
    name: "stripe_feeds",
    sql: `
-- Stripe as a bank feed (ST1-ST10, decisions 392-395): the organisation's own
-- restricted Stripe API key, encrypted with the server's TOHYEE_SECRET_KEY and
-- cleared on disconnect. One active connection at a time.
create table stripe_connections (
  id bigserial primary key,
  api_key_ciphertext text,
  key_hint text not null check (length(key_hint) between 1 and 40),
  live_mode boolean not null,
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- Stripe's balance per currency when last read: [{currency, available, pending}].
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
  check (status = 'removed' or api_key_ciphertext is not null)
);
create unique index stripe_connections_one_active on stripe_connections ((true)) where status = 'active';

-- A Stripe balance currency linked to a bank account in that currency.
create table stripe_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references stripe_connections(id),
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
create unique index stripe_links_currency_once on stripe_links (currency_code) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check check (source in ('file', 'akahu', 'simplefin', 'stripe'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin', 'stripe'));
`,
  };
