import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0223",
    name: "sales_platform_buyers_only",
    sql: `
-- Shopify import fixes from the first live sync (decisions 1334-1341).
-- customer_scope: 'all' brings in every store customer; 'buyers' only
-- customers who have ordered (a contact is added when their first order is
-- posted, and kept up to date after that). New connections default to
-- 'buyers'; existing ones keep 'all' until an admin changes it.
alter table sales_platform_connections
  add column customer_scope text not null default 'all' check (customer_scope in ('all', 'buyers'));
alter table sales_platform_connections alter column customer_scope set default 'buyers';
-- Variants without a SKU are now added (or linked) by their Shopify ID, so
-- products are read again in full once: those skipped before come in.
-- Variants already linked are matched by their link and change nothing.
update sales_platform_connections set products_synced_until = null
 where sync_products and status <> 'disconnected';
`,
  };
