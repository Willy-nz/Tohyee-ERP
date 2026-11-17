import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0089",
    name: "dashboard_preferences",
    sql: `
create table dashboard_preferences (
  user_id uuid not null,
  page text not null check (length(page) between 1 and 120),
  hidden boolean not null default false,
  tiles jsonb not null default '[]'::jsonb
    check (jsonb_typeof(tiles) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (user_id, page)
);
`,
  };
