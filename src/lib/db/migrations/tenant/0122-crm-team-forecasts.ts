import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0122",
    name: "crm_team_forecasts",
    sql: `
-- Team forecasts (decision 499, #216 stage 3; Jess 10 Oct 2026): team
-- roll-ups, manager adjustments with a reason (every change kept), and
-- submitted snapshots to compare later. Currencies stay apart.
create table crm_forecast_adjustments (
  id bigserial primary key,
  owner_user_id text not null check (length(owner_user_id) between 1 and 200),
  period_kind text not null check (period_kind in ('month', 'quarter')),
  period_start date not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  measure text not null check (measure in ('commit', 'bestCase')),
  -- null clears the adjustment: the figure goes back to the deals' own.
  amount numeric(20, 2) check (amount is null or amount >= 0),
  reason text check (reason is null or length(reason) <= 500),
  adjusted_by_user_id text,
  adjusted_by_email text,
  created_at timestamptz not null default now(),
  check (amount is null or reason is not null)
);
create index crm_forecast_adjustments_lookup on crm_forecast_adjustments (period_kind, period_start, owner_user_id, currency_code, measure, id desc);

create table crm_forecast_snapshots (
  id bigserial primary key,
  -- Whose forecast: one person's, a team's (its name kept if the team goes), or everyone's.
  scope_kind text not null check (scope_kind in ('owner', 'team', 'all')),
  owner_user_id text,
  team_id bigint references crm_teams(id) on delete set null,
  team_name text,
  period_kind text not null check (period_kind in ('month', 'quarter')),
  period_start date not null,
  period_label text not null,
  figures jsonb not null,
  note text check (note is null or length(note) <= 500),
  submitted_by_user_id text,
  submitted_by_email text,
  submitted_at timestamptz not null default now(),
  check ((scope_kind = 'owner') = (owner_user_id is not null)),
  check (scope_kind = 'team' or team_id is null),
  check (scope_kind <> 'team' or team_name is not null)
);
create index crm_forecast_snapshots_period on crm_forecast_snapshots (period_kind, period_start, submitted_at desc);
`,
  };
