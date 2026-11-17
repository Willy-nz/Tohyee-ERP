import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0056",
    name: "sales_platform_connections",
    sql: `
-- Sales platform connections, stage 1 (examples SPC1-SPC10): connections to
-- sales platforms (Shopify first), the links from a platform's records to
-- Tohyee's contacts and items, a sync log people can read, and the webhook
-- deliveries already handled. Nothing here posts to the ledger. Versions
-- 0051-0055 are reserved by other branches.
create table sales_platform_connections (
  id bigserial primary key,
  platform text not null check (platform in ('shopify')),
  store_domain text not null check (length(store_domain) between 1 and 255),
  store_name text check (store_name is null or length(store_name) <= 255),
  store_currency text check (store_currency is null or store_currency ~ '^[A-Z]{3}$'),
  prices_include_tax boolean,
  auth_method text not null check (length(auth_method) between 1 and 40),
  -- The platform's credentials as encrypted JSON (TOHYEE_SECRET_KEY); removed on disconnecting.
  credentials_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- Random, in the webhook address, so deliveries can find their connection.
  webhook_key text not null unique check (length(webhook_key) >= 32),
  webhook_subscription_ids text[] not null default '{}',
  webhooks_note text,
  sync_customers boolean not null default true,
  sync_products boolean not null default true,
  status text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  customers_synced_until timestamptz,
  products_synced_until timestamptz,
  last_sync_at timestamptz,
  last_error text,
  failures integer not null default 0,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  disconnected_by_email text,
  disconnected_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (credentials_ciphertext is null)),
  check (status <> 'disconnected' or (access_token_ciphertext is null and disconnected_at is not null))
);
-- A store is connected at most once at a time.
create unique index sales_platform_connections_store_idx
  on sales_platform_connections (platform, lower(store_domain)) where status <> 'disconnected';

-- Which Tohyee record each platform record is, so nothing is brought in
-- twice, with the values the platform last had (to tell whether someone
-- changed a value in Tohyee). Removed on disconnecting.
create table sales_platform_mappings (
  id bigserial primary key,
  connection_id bigint not null references sales_platform_connections(id),
  record_kind text not null check (record_kind in ('customer', 'product_variant')),
  external_id text not null check (length(external_id) between 1 and 100),
  contact_id bigint references contacts(id),
  item_id bigint references items(id),
  synced_values jsonb not null default '{}',
  external_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((record_kind = 'customer') = (contact_id is not null)),
  check ((record_kind = 'product_variant') = (item_id is not null)),
  unique (connection_id, record_kind, external_id)
);
create unique index sales_platform_mappings_contact_idx on sales_platform_mappings (connection_id, contact_id) where contact_id is not null;
create unique index sales_platform_mappings_item_idx on sales_platform_mappings (connection_id, item_id) where item_id is not null;

-- What each sync and webhook did. Append-only, and kept after disconnecting.
create table sales_platform_sync_log (
  id bigserial primary key,
  connection_id bigint not null references sales_platform_connections(id),
  logged_at timestamptz not null default now(),
  source text not null check (source in ('sync', 'webhook', 'connection')),
  action text not null check (action in (
    'connected', 'tested', 'settings', 'webhooks', 'disconnected', 'sync',
    'created', 'linked', 'updated', 'kept', 'skipped', 'failed')),
  record_kind text check (record_kind is null or record_kind in ('customer', 'product_variant')),
  external_id text check (external_id is null or length(external_id) <= 100),
  contact_id bigint references contacts(id),
  item_id bigint references items(id),
  message text not null check (length(message) between 1 and 1000),
  actor_email text not null
);
create index sales_platform_sync_log_connection_idx on sales_platform_sync_log (connection_id, id desc);
create index sales_platform_sync_log_record_idx on sales_platform_sync_log (connection_id, record_kind, external_id, id desc);
create trigger sales_platform_sync_log_no_update before update or delete on sales_platform_sync_log
  for each row execute function toeyee_forbid_mutation();
create trigger sales_platform_sync_log_no_truncate before truncate on sales_platform_sync_log
  for each statement execute function toeyee_forbid_mutation();

-- Webhook deliveries already handled (by the platform's delivery ID), so a
-- delivery sent again does nothing.
create table sales_platform_webhook_deliveries (
  connection_id bigint not null references sales_platform_connections(id),
  delivery_id text not null check (length(delivery_id) between 1 and 200),
  topic text not null check (length(topic) between 1 and 100),
  received_at timestamptz not null default now(),
  primary key (connection_id, delivery_id)
);
`,
  };
