import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0278",
    name: "livestock_bobby_calves",
    sql: `
-- Purchased bobby calves under national standard cost (#243, decision 1603;
-- LV29): IRD's NSC determination (clause 3 of the 1993 base determination)
-- adds the NSC for acquired bobby calves for each one bought in the year.
-- Bobby calves: dairy-bred, bought unweaned for rearing, not at foot with
-- the dam. Marked on the purchase, for beef or dairy cattle.
alter table livestock_movements add column bobby_calves boolean not null default false;
alter table livestock_movements add constraint livestock_movements_bobby_calves
  check (not bobby_calves or (movement_type = 'purchase' and kind in ('dairy_cattle', 'beef_cattle')));
`,
  };
