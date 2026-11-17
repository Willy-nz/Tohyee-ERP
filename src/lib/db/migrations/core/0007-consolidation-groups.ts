import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0007",
    name: "consolidation_groups",
    sql: `
-- Consolidation (CO1-CO11, decisions 437-445): groups of organisations on
-- this server reported together in the parent's currency. Only what belongs
-- to the group lives here: no accounting data, which stays in each
-- organisation's own database and is read from there for each report.
create table consolidation_groups (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  parent_organisation_id text not null references organisations(id),
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  created_by_user_id uuid references users(id) on delete set null,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index consolidation_groups_name_key on consolidation_groups (lower(name)) where archived_at is null;

create table consolidation_group_members (
  group_id bigint not null references consolidation_groups(id),
  organisation_id text not null references organisations(id),
  added_by_email text not null,
  added_at timestamptz not null default now(),
  primary key (group_id, organisation_id)
);

-- A month's consolidation rate an admin changed (NetSuite's edited
-- consolidated rates); every other rate is worked out from the parent's
-- exchange rates list each time.
create table consolidation_rate_overrides (
  group_id bigint not null references consolidation_groups(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('current', 'average', 'historical')),
  rate numeric not null check (rate > 0 and scale(rate) <= 8),
  reason text not null check (length(reason) between 1 and 200),
  changed_by_email text not null,
  changed_at timestamptz not null default now(),
  primary key (group_id, currency_code, month, kind)
);

-- Budget exchange rates (CO11): one a month per member currency, typed.
create table consolidation_budget_rates (
  group_id bigint not null references consolidation_groups(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  month date not null check (extract(day from month) = 1),
  rate numeric not null check (rate > 0 and scale(rate) <= 8),
  changed_by_email text not null,
  changed_at timestamptz not null default now(),
  primary key (group_id, currency_code, month)
);

-- Elimination adjustments (CO7), in the group's currency, posted nowhere else.
create table consolidation_adjustments (
  id bigserial primary key,
  group_id bigint not null references consolidation_groups(id),
  adjustment_date date not null,
  description text not null check (length(description) between 1 and 200),
  removed_at timestamptz,
  removed_by_email text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((removed_at is null) = (removed_by_email is null))
);
create table consolidation_adjustment_lines (
  id bigserial primary key,
  adjustment_id bigint not null references consolidation_adjustments(id),
  line_order integer not null check (line_order > 0),
  organisation_id text not null references organisations(id),
  account_code text not null check (length(account_code) between 1 and 20),
  debit numeric not null default 0 check (debit >= 0),
  credit numeric not null default 0 check (credit >= 0),
  check ((debit = 0) <> (credit = 0)),
  unique (adjustment_id, line_order)
);
`,
  };
