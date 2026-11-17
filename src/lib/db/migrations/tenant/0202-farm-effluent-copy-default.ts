import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0202",
    name: "farm_effluent_copy_default",
    sql: `
-- The weekly copy includes the effluent records by default on farms with an
-- effluent system (Jess, 29 October 2026; #487). Empty means "the default";
-- an owner or admin can still choose yes or no. The column came in 0201, off,
-- before anyone could have chosen, so those become the default.
alter table safety_copy_settings alter column include_effluent drop not null;
alter table safety_copy_settings alter column include_effluent drop default;
update safety_copy_settings set include_effluent = null where include_effluent = false;
`,
  };
