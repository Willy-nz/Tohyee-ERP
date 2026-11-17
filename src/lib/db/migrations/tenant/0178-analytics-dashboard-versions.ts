import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0178",
    name: "analytics_dashboard_versions",
    sql: `
-- Each saved report has a version (#387, decision 690). A save names the
-- version it started from and is refused when someone else has saved since,
-- so two people editing one report can't silently overwrite each other.
alter table analytics_dashboards add column version integer not null default 1 check (version >= 1);
`,
  };
