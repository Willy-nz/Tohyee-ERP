import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0281",
    name: "livestock_bobby_calves_sold",
    sql: `
-- Dairy calves sold as bobby calves can be marked too: IRD's NSC formula
-- leaves them out of the rising one-year average (clause 3 of the 1993
-- determination; decision 1606, LV32).
alter table livestock_movements drop constraint livestock_movements_bobby_calves;
alter table livestock_movements add constraint livestock_movements_bobby_calves
  check (not bobby_calves or (movement_type = 'purchase' and kind in ('dairy_cattle', 'beef_cattle')) or (movement_type = 'sale' and kind = 'dairy_cattle'));
`,
  };
