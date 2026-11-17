import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0087",
    name: "analytics_shaped_tables",
    sql: `
-- Shaping definitions stay with the organisation's backed-up data. The
-- transformed rows themselves live in its rebuildable DuckDB file.
create table analytics_shaped_tables (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  table_name text not null unique check (
    table_name ~ '^[a-z][a-z0-9_]{0,62}$'
    and table_name not like 'tohyee\\_%' escape '\\'
  ),
  base_table text not null check (base_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 100),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create index analytics_shaped_tables_base_idx on analytics_shaped_tables (base_table);

-- Keep rebuilds in the same history as CSV and books loads. Deleting a
-- definition keeps its history, just as deleting a CSV source does.
alter table analytics_load_runs add column shaped_table_id bigint
  references analytics_shaped_tables(id) on delete set null;
create index analytics_load_runs_shape_idx on analytics_load_runs (shaped_table_id, started_at desc);
`,
  };
