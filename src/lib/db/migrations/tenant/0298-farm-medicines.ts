import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0298",
    name: "farm_medicines",
    sql: `
-- The medicine cabinet (examples MED1-MED10). Nothing here posts to the
-- ledger.
-- Used without a treatment record (MED4), and moved between farms (MED5).
alter table farm_product_stock drop constraint farm_product_stock_movement_type_check;
alter table farm_product_stock add constraint farm_product_stock_movement_type_check check (movement_type in ('received', 'counted', 'disposed', 'used', 'moved_out', 'moved_in'));
-- A move's other half, on the other farm's product.
alter table farm_product_stock add column moved_farm_id bigint references farms(id);

-- A chemical register product in its farm's cabinet, with its kind, its own
-- photo and its reorder level (MED1-MED3, MED6).
create table farm_medicines (
  chemical_record_id uuid primary key,
  farm_id bigint not null references farms(id),
  kind text not null check (kind ~ '^[a-z_]{2,40}$'),
  photo_file_id uuid references safety_files(id),
  reorder_at numeric(18, 3) check (reorder_at >= 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create index farm_medicines_farm on farm_medicines (farm_id);
`,
};
