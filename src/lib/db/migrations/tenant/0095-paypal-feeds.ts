import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0095",
    name: "paypal_feeds",
    sql: `
-- PayPal as a bank feed (PP1-PP10, decisions 396-399): the organisation's own
-- PayPal REST app. Its client secret (PayPal has no read-only credentials) is
-- encrypted with the server's TOHYEE_SECRET_KEY and cleared on disconnect.
create table paypal_connections (
  id bigserial primary key,
  client_id text not null check (length(client_id) between 1 and 200),
  client_secret_ciphertext text,
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- PayPal's balances when last read: [{currency, total, available, withheld}].
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
  check (status = 'removed' or client_secret_ciphertext is not null)
);
create unique index paypal_connections_one_active on paypal_connections ((true)) where status = 'active';

-- A PayPal balance currency linked to a bank account in that currency.
create table paypal_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references paypal_connections(id),
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
create unique index paypal_links_currency_once on paypal_links (currency_code) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check
  check (source in ('file', 'akahu', 'simplefin', 'stripe', 'paypal'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin', 'stripe', 'paypal'));
`,
  };
