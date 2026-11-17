import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0093",
    name: "simplefin_feeds",
    sql: `
-- SimpleFIN bank feeds (SF1-SF10, decisions 388-391): the organisation's own
-- SimpleFIN Bridge connection. The access URL (which holds its credentials) is
-- encrypted with the server's TOHYEE_SECRET_KEY and cleared on disconnect.
-- One active connection at a time.
create table simplefin_connections (
  id bigserial primary key,
  access_url_ciphertext text,
  host text not null check (length(host) between 1 and 253),
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  sync_minute integer not null check (sync_minute between 0 and 59),
  status text not null default 'active' check (status in ('active', 'removed')),
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  last_problems jsonb not null default '[]'::jsonb,
  -- The accounts the Bridge last listed (id, name, currency, connection), for linking.
  accounts jsonb not null default '[]'::jsonb,
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null)),
  check (status = 'removed' or access_url_ciphertext is not null)
);
create unique index simplefin_connections_one_active on simplefin_connections ((true)) where status = 'active';

-- Every request made to the Bridge, so Tohyee stays under its 24 a day (SF5).
create table simplefin_requests (
  id bigserial primary key,
  connection_id bigint not null references simplefin_connections(id),
  made_at timestamptz not null default now()
);
create index simplefin_requests_made_at_idx on simplefin_requests (made_at);

-- A SimpleFIN account linked to a bank or credit card account: its currency
-- (which must be the account's), the first date to bring in, and the time
-- zone that turns SimpleFIN's posted times into dates (SF3).
create table simplefin_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references simplefin_connections(id),
  simplefin_account_id text not null check (length(simplefin_account_id) between 1 and 200),
  simplefin_account_name text check (simplefin_account_name is null or length(simplefin_account_name) <= 200),
  connection_name text check (connection_name is null or length(connection_name) <= 200),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  start_date date not null,
  time_zone text not null check (length(time_zone) between 1 and 64),
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  last_skipped jsonb not null default '[]'::jsonb,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or connection_id is not null)
);
create unique index simplefin_links_account_once on simplefin_links (simplefin_account_id) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check check (source in ('file', 'akahu', 'simplefin'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin'));
`,
  };
