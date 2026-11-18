import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0291",
    name: "sales_platform_order_history",
    sql: `
-- Shopify lets an app without read_all_orders read only the last 60 days of
-- orders (examples SPC47-SPC48). orders_read_from is the first day the
-- first full read of a store's orders could reach: the start date when every
-- order could be read, else 60 days before that read. Orders before it were
-- never seen, so the store's card warns, and adding read_all_orders reads
-- them all once. Connections that have already read orders get their
-- connection day less 60 days, the most Shopify could have given them.
alter table sales_platform_connections add column if not exists orders_read_from date;
update sales_platform_connections
   set orders_read_from = greatest(start_date, (connected_at at time zone 'Pacific/Auckland')::date - 60)
 where platform = 'shopify' and orders_synced_until is not null and start_date is not null
   and not ('read_all_orders' = any(granted_scopes));
update sales_platform_connections
   set orders_read_from = start_date
 where orders_read_from is null and orders_synced_until is not null and start_date is not null;

-- Words on a bank line that mean the store's payout (example SPC50), besides
-- the platform's own name: e.g. the store name the bank shows.
alter table sales_platform_connections add column if not exists payout_bank_words text[] not null default '{}';
`,
  };
