import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0184",
    name: "analytics_fields",
    sql: `
-- Calculated fields on a data source (#376 phase 4, decision 772): a
-- formula worked out on each row of a loaded table, saved under a name so
-- any report's tiles can use it like one of the table's columns. Only the
-- formula is stored; its SQL and type are worked out from it each time.
create table analytics_fields (
  id bigserial primary key,
  table_name text not null check (length(table_name) between 1 and 120),
  name text not null check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  formula text not null check (length(formula) between 1 and 1000),
  description text check (description is null or length(description) <= 300),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  unique (table_name, name)
);
`,
  };
