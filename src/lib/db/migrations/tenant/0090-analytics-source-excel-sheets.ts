import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0090",
    name: "analytics_source_excel_sheets",
    sql: `
alter table analytics_sources add column sheet_name text
  check (sheet_name is null or length(sheet_name) between 1 and 31);
`,
  };
