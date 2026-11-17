import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0230",
    name: "analytics_dashboard_history",
    sql: `
-- A report's edit history (#591, decision 1414): every saved version, who
-- saved it and how (in Tohyee, or through an AI key or AI app), and what
-- changed, so a person can see a change and put an earlier version back.
-- Each report starts with the version it has now.
create table analytics_dashboard_history (
  id bigserial primary key,
  dashboard_id bigint not null references analytics_dashboards (id) on delete cascade,
  version integer not null check (version >= 1),
  name text not null,
  description text,
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  tiles jsonb not null check (jsonb_typeof(tiles) = 'array'),
  saved_by_email text not null,
  saved_via text check (saved_via is null or length(saved_via) <= 300),
  change text not null check (length(change) between 1 and 500),
  saved_at timestamptz not null default now(),
  unique (dashboard_id, version)
);
insert into analytics_dashboard_history (dashboard_id, version, name, description, settings, tiles, saved_by_email, change, saved_at)
  select id, version, name, description, settings, tiles, updated_by_email, 'As it was when edit history started', updated_at from analytics_dashboards;
`,
  };
