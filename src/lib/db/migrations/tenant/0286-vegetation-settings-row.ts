import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0286",
    name: "vegetation_settings_row",
    sql: `
-- The greenness settings row used to be made the first time anything read
-- it, which a read-only transaction (an AI's Look only call) can't do
-- (decision 1672). It's made here instead, with the table's defaults.
insert into vegetation_settings (id) values (true) on conflict (id) do nothing;
`,
  };
