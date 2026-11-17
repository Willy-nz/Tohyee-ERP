import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0083",
    name: "analytics_dashboards",
    sql: `
-- Analytics dashboards (step 3 of docs/ANALYTICS-REVIEW.md): tiles that each
-- ask one question of a loaded table, with a date range and slicers for the
-- whole dashboard. The questions are kept here (backed up with the
-- organisation); the answers are worked out from the DuckDB file each time.
create table analytics_dashboards (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 500),
  -- { "from": "2026-01-01" | null, "to": ... , "slicers": [{ "field": "region", "label": "Region" }] }
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- [{ "id", "title", "visual", "width", "query": { table, groupBy, measures, filters, dateField, sort, limit } }]
  tiles jsonb not null default '[]'::jsonb check (jsonb_typeof(tiles) = 'array'),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
`,
  };
