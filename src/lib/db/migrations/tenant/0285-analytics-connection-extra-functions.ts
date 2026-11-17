import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0285",
    name: "analytics_connection_extra_functions",
    sql: `
-- Functions a database connection's typed queries may call besides the
-- ones Tohyee knows (decision 1667). Names only, lower case.
alter table analytics_db_connections add column extra_functions text[] not null default '{}';
`,
  };
