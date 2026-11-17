import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0085",
    name: "analytics_dashboard_shares",
    sql: `
-- Dashboards shared with report viewers (decision 360): they see only these,
-- after signing in. user_id is the core database's user id.
create table analytics_dashboard_shares (
  dashboard_id bigint not null references analytics_dashboards(id) on delete cascade,
  user_id text not null check (user_id ~ '^[0-9a-f-]{36}$'),
  shared_by_email text not null,
  shared_at timestamptz not null default now(),
  primary key (dashboard_id, user_id)
);
create index analytics_dashboard_shares_user_idx on analytics_dashboard_shares (user_id);
`,
  };
