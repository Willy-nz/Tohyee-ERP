import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0214",
    name: "sales_platform_shopify_extras",
    sql: `
-- Shopify's read-only extras (decisions 1237-1245, examples SPD1-SPD10):
-- stock levels by location, shop stats, discounts, gift cards, and the
-- discounts, shipments and shipping charged on orders brought in. Copies
-- of what Shopify said, for the Sales platforms page and Analytics.
-- Nothing here posts to the ledger or changes Tohyee's stock. Gift cards
-- keep only their last four characters, never the code; nothing here
-- holds a customer's name, email, phone or address.
alter table sales_platform_connections
  -- When the stock, discounts and gift cards were last read (at most hourly; "Sync now" reads them again).
  add column extras_synced_at timestamptz,
  -- When the shop stats were last read (at most every 6 hours).
  add column stats_synced_at timestamptz;

create table sales_platform_locations (
  connection_id bigint not null references sales_platform_connections(id),
  external_id text not null check (length(external_id) between 1 and 100),
  name text not null check (length(name) between 1 and 255),
  is_active boolean not null,
  synced_at timestamptz not null default now(),
  primary key (connection_id, external_id)
);

-- Shopify's stock per variant per location, as last read (replaced each time).
create table sales_platform_stock_levels (
  connection_id bigint not null references sales_platform_connections(id),
  variant_external_id text not null check (length(variant_external_id) between 1 and 100),
  location_external_id text not null check (length(location_external_id) between 1 and 100),
  inventory_item_external_id text not null check (length(inventory_item_external_id) between 1 and 100),
  sku text check (sku is null or length(sku) <= 255),
  product_title text check (product_title is null or length(product_title) <= 255),
  variant_title text check (variant_title is null or length(variant_title) <= 255),
  available numeric not null,
  on_hand numeric not null,
  synced_at timestamptz not null default now(),
  primary key (connection_id, variant_external_id, location_external_id)
);

-- Shopify's own daily figures (ShopifyQL), in the store's currency and days.
create table sales_platform_shop_stats (
  connection_id bigint not null references sales_platform_connections(id),
  day date not null,
  sessions bigint,
  -- As Shopify sent it (a percentage).
  conversion_rate numeric,
  orders bigint,
  gross_sales numeric,
  net_sales numeric,
  synced_at timestamptz not null default now(),
  primary key (connection_id, day)
);

create table sales_platform_shop_sales (
  connection_id bigint not null references sales_platform_connections(id),
  day date not null,
  dimension text not null check (dimension in ('product', 'channel')),
  value text not null check (length(value) between 1 and 255),
  orders bigint,
  gross_sales numeric,
  net_sales numeric,
  synced_at timestamptz not null default now(),
  primary key (connection_id, day, dimension, value)
);

create table sales_platform_discounts (
  connection_id bigint not null references sales_platform_connections(id),
  external_id text not null check (length(external_id) between 1 and 100),
  method text not null check (method in ('code', 'automatic')),
  title text not null check (length(title) between 1 and 255),
  discount_type text not null check (length(discount_type) between 1 and 40),
  value_type text check (value_type is null or value_type in ('percentage', 'amount')),
  value numeric,
  starts_at timestamptz,
  ends_at timestamptz,
  status text check (status is null or length(status) <= 40),
  times_used integer,
  synced_at timestamptz not null default now(),
  primary key (connection_id, external_id)
);

-- What Shopify said about each order brought in, beyond what was posted.
create table sales_platform_order_details (
  connection_id bigint not null references sales_platform_connections(id),
  order_external_id text not null check (length(order_external_id) between 1 and 100),
  order_name text check (order_name is null or length(order_name) <= 100),
  processed_at timestamptz,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  discounts_total numeric,
  shipping_charged numeric,
  fulfilment_status text check (fulfilment_status is null or length(fulfilment_status) <= 40),
  fulfilment_order_statuses text[],
  synced_at timestamptz not null default now(),
  primary key (connection_id, order_external_id)
);

create table sales_platform_order_discounts (
  connection_id bigint not null references sales_platform_connections(id),
  order_external_id text not null check (length(order_external_id) between 1 and 100),
  application_index integer not null check (application_index >= 0),
  kind text not null check (kind in ('code', 'automatic', 'manual', 'script', 'other')),
  code text check (code is null or length(code) <= 255),
  title text check (title is null or length(title) <= 255),
  value_type text check (value_type is null or value_type in ('percentage', 'amount')),
  value numeric,
  amount numeric not null,
  primary key (connection_id, order_external_id, application_index)
);

create table sales_platform_fulfilments (
  connection_id bigint not null references sales_platform_connections(id),
  external_id text not null check (length(external_id) between 1 and 100),
  order_external_id text not null check (length(order_external_id) between 1 and 100),
  status text check (status is null or length(status) <= 40),
  created_on_platform_at timestamptz,
  delivered_at timestamptz,
  carrier text check (carrier is null or length(carrier) <= 255),
  tracking_number text check (tracking_number is null or length(tracking_number) <= 255),
  primary key (connection_id, external_id)
);
create index sales_platform_fulfilments_order_idx on sales_platform_fulfilments (connection_id, order_external_id);

-- Never the code: only its last characters (at most 4, letters and digits).
create table sales_platform_gift_cards (
  connection_id bigint not null references sales_platform_connections(id),
  external_id text not null check (length(external_id) between 1 and 100),
  last_characters text not null check (last_characters ~ '^[A-Za-z0-9?]{1,4}$'),
  initial_value numeric not null,
  balance numeric not null,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  expires_on date,
  enabled boolean not null,
  created_on_platform_at timestamptz,
  deactivated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (connection_id, external_id)
);

create table sales_platform_gift_card_transactions (
  connection_id bigint not null references sales_platform_connections(id),
  external_id text not null check (length(external_id) between 1 and 100),
  gift_card_external_id text not null check (length(gift_card_external_id) between 1 and 100),
  kind text not null check (kind in ('credit', 'debit', 'cash_out', 'other')),
  amount numeric not null,
  processed_at timestamptz not null,
  primary key (connection_id, external_id)
);
`,
  };
