import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0311",
    name: "farm_product_stock_operations",
    sql: `
-- A medicine or chemical stock entry, or a move between farms, sent again
-- after a lost reply is found by its operation id instead of being recorded
-- twice (OPF3). A move keeps the id on its moved_out row only.
alter table farm_product_stock add column operation_id uuid;
alter table farm_product_stock add column request_hash text check (request_hash is null or length(request_hash) = 64);
create unique index farm_product_stock_operation on farm_product_stock (operation_id) where operation_id is not null;
`,
  };
