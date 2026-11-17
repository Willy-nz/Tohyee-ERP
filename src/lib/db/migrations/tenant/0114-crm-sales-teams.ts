import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0114",
    name: "crm_sales_teams",
    sql: `
-- Sales teams (decision 491, #216): an admin or owner makes them. A team has
-- one manager, who sees the deals, tasks and forecasts of its reps; a rep is
-- in one team at most. User ids are the core database's users (as the CRM's
-- owner and assignee columns).
create table crm_teams (
  id bigserial primary key,
  name text not null unique check (length(name) between 1 and 100),
  manager_user_id text not null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_teams_manager on crm_teams (manager_user_id);

create table crm_team_members (
  user_id text primary key,
  team_id bigint not null references crm_teams(id) on delete cascade,
  added_by_email text,
  added_at timestamptz not null default now()
);
create index crm_team_members_team on crm_team_members (team_id);
`,
  };
