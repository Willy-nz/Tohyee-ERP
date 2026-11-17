import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0273",
    name: "sales_platform_gift_cards",
    sql: `
-- Where a Shopify store's gift cards sold are held until they're spent (GC1-GC5,
-- decision 1590). Null: orders with gift cards are refused, as before.
alter table sales_platform_connections add column gift_card_account_id bigint references accounts(id);
`,
  };
