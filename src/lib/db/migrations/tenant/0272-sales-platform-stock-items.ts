import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0272",
    name: "sales_platform_stock_items",
    sql: `
-- Whether a store's tracked products come in as stock items (SSD1, decision
-- 1589). True keeps what happened before; a made-to-order shop says no.
alter table sales_platform_connections add column stock_items boolean not null default true;
`,
  };
