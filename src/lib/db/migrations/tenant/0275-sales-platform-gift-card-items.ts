import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0275",
    name: "sales_platform_gift_card_items",
    sql: `
-- Products a store sells as gift cards that Shopify doesn't mark as gift cards
-- (a voucher app's products, say): GC6, decision 1594. Their sales are held in
-- the store's gift card account, as Shopify gift cards are.
create table sales_platform_gift_card_items (
  connection_id bigint not null references sales_platform_connections(id),
  item_id bigint not null references items(id),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  primary key (connection_id, item_id)
);
`,
  };
