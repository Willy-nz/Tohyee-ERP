import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0165",
    name: "analytics_measures",
    sql: `
-- Saved values on a data source (#337, decision 597): a name and how it's
-- worked out (an aggregate with its own conditions, or a formula over named
-- inputs), for any chart on that table to use. table_name is the loaded
-- table's name; the built-in values of the books copy aren't stored here.
create table analytics_measures (
  id bigserial primary key,
  table_name text not null check (length(table_name) between 1 and 120),
  name text not null check (length(name) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  -- { "kind": "base", "aggregate", "field", ... } or { "kind": "formula", "formula", "inputs": [...] }
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  -- How it's best shown, e.g. { "style": "percent", "decimals": 1 }
  number_format jsonb check (number_format is null or jsonb_typeof(number_format) = 'object'),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create unique index analytics_measures_name on analytics_measures (table_name, lower(name));
`,
  };
