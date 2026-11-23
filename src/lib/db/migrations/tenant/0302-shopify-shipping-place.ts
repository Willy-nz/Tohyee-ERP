import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0302",
  name: "shopify_shipping_place",
  sql: `
-- Where each Shopify order is going, for the region map in Analytics
-- (SHP1-SHP5): the region (Shopify's province, e.g. Otago), the town or city
-- and the country code from its shipping address. Never the street, postcode
-- or name. shipping_place_read says it's been asked for, so orders brought in
-- before this are read again (a few hundred at a time) and only once.
alter table sales_platform_order_details add column if not exists shipping_region text;
alter table sales_platform_order_details add column if not exists shipping_town text;
alter table sales_platform_order_details add column if not exists shipping_country text;
alter table sales_platform_order_details add column if not exists shipping_place_read boolean not null default false;
create index if not exists sales_platform_order_details_place_unread
  on sales_platform_order_details (connection_id) where not shipping_place_read;
`,
};
