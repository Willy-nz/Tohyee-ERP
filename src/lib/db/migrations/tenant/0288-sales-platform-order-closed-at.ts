import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0288",
    name: "sales_platform_order_closed_at",
    sql: `
-- When Shopify archived (closed) an order (#803, example SWS15, decision
-- 1692): Sales › To send leaves archived orders out unless something is
-- still held for them. Overwritten at each read, so an order brought back
-- from the archive is listed again.
alter table sales_platform_order_details add column if not exists closed_at timestamptz;
`,
  };
