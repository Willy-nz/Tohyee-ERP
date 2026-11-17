import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0185",
    name: "analytics_relationships_and_field_settings",
    sql: `
-- Relationships between loaded tables (#376 phase 4, decision 774): each
-- row of fact_table matches at most one row of dimension_table on the key
-- columns, so a tile on the fact table can use the dimension's fields as
-- <name>.<field>. Checked on the data when saved and before each answer
-- that uses it; many-to-many is refused.
create table analytics_relationships (
  id bigserial primary key,
  fact_table text not null check (length(fact_table) between 1 and 120),
  fact_field text not null check (length(fact_field) between 1 and 120),
  dimension_table text not null check (length(dimension_table) between 1 and 120),
  dimension_field text not null check (length(dimension_field) between 1 and 120),
  name text not null check (name ~ '^[a-z][a-z0-9_]{0,30}$'),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (fact_table, name),
  check (fact_table <> dimension_table)
);
-- Field settings on a loaded table (#376 phase 4, decision 775, used from
-- the next change): how a column is sorted (by another column), added up
-- by default, formatted, and which folder and description it has in the
-- field list. One row per table and column; nothing here changes data.
create table analytics_field_settings (
  table_name text not null check (length(table_name) between 1 and 120),
  field_name text not null check (length(field_name) between 1 and 120),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (table_name, field_name)
);
`,
  };
