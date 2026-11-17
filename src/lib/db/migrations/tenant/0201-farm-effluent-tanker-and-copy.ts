import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0201",
    name: "farm_effluent_tanker_and_copy",
    sql: `
-- Effluent part 4 (#487, decision 1099): a tanker or spreader run
-- can be recorded in tractor mode as effluent work, and the weekly copy can
-- include the effluent records if the farm wants (off unless chosen).
alter table tractor_jobs drop constraint tractor_jobs_operation_check;
alter table tractor_jobs add constraint tractor_jobs_operation_check check (operation in ('spreading', 'spraying', 'mowing', 'effluent', 'other'));
alter table safety_copy_settings add column include_effluent boolean not null default false;
`,
  };
