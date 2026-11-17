import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0052",
    name: "not_for_profit_module",
    sql: `
alter table organisation_settings
  add column not_for_profit_enabled boolean not null default false;
`,
  };
