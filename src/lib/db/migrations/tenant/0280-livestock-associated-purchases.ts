import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0280",
    name: "livestock_associated_purchases",
    sql: `
-- Livestock bought from an associated person who valued it under the herd
-- scheme, outside the ordinary course of business and none of IRD's other
-- exceptions (s EC 4B; OS 25/02 paras 54-58): the buyer must keep it in the
-- herd scheme (#243, decision 1605; LV31). Marked on the purchase.
alter table livestock_movements add column bound_to_herd_scheme boolean not null default false;
alter table livestock_movements add constraint livestock_movements_bound_to_herd_scheme
  check (not bound_to_herd_scheme or movement_type = 'purchase');
`,
  };
