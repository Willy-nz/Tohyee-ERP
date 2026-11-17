import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0284",
    name: "organisation_directory",
    sql: `
-- The organisation's directory (decision 1656): its registered office,
-- registration numbers, officers (directors, trustees) and advisers
-- (accountant, bank, solicitor), kept once here for the directory page of
-- printed reports. Null until someone fills it in.
alter table organisation_settings add column directory jsonb check (directory is null or jsonb_typeof(directory) = 'object');
`,
  };
