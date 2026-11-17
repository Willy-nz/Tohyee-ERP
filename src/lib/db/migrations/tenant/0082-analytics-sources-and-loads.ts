import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0082",
    name: "analytics_sources_and_loads",
    sql: `
-- Analytics (decisions 353-358). The module is switched on per organisation.
alter table organisation_settings add column analytics_enabled boolean not null default false;

-- A file in the organisation's analytics folder and how it's loaded: which
-- columns, named what, as which type (money as exact decimals, decision 356).
-- The loaded data itself lives in the organisation's DuckDB file.
create table analytics_sources (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  -- The DuckDB table it loads into.
  table_name text not null unique check (table_name ~ '^[a-z][a-z0-9_]{0,62}$' and table_name not like '_tohyee%'),
  -- Path inside the organisation's folder, with / between folders.
  file_name text not null check (length(file_name) between 1 and 500),
  delimiter text not null default ',' check (length(delimiter) = 1),
  -- [{ "source": "Unit price", "name": "unit_price", "kind": "money" }]
  columns jsonb not null check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) > 0),
  reload_daily boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- Every load, written by the loader as it works (decision 357), never
-- typed in. Kept when a source is removed, so the history stays.
create table analytics_load_runs (
  id bigserial primary key,
  source_id bigint references analytics_sources(id) on delete set null,
  source_name text not null,
  table_name text not null,
  file_name text not null,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_loaded bigint,
  milliseconds integer,
  error text,
  requested_by_email text
);
create index analytics_load_runs_source_idx on analytics_load_runs (source_id, started_at desc);
create index analytics_load_runs_started_idx on analytics_load_runs (started_at desc);
`,
  };
