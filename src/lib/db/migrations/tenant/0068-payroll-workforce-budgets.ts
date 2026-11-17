import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0068",
    name: "payroll_workforce_budgets",
    sql: `
-- Payroll stage P11 (docs/ACCOUNTING-EXAMPLES.md WB1-WB7; docs/DECISIONS.md
-- 112-123): workforce budgets of wages by employee or position and month,
-- written into the budgets they feed. Workforce budgets post nothing.

create table payroll_workforce_budgets (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  first_month date not null check (extract(day from first_month) = 1),
  months integer not null check (months between 1 and 24),
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create unique index payroll_workforce_budgets_name_idx on payroll_workforce_budgets (lower(name));

-- The budgets a workforce budget feeds; a budget is fed by at most one (decision 120).
create table payroll_workforce_budget_targets (
  workforce_budget_id uuid not null references payroll_workforce_budgets(id),
  budget_id bigint not null unique references budgets(id),
  added_by_email text not null,
  added_at timestamptz not null default now(),
  primary key (workforce_budget_id, budget_id)
);

-- Lines: an employee or a position (decision 114). Replaced as a set on each save.
create table payroll_workforce_budget_lines (
  id uuid primary key default gen_random_uuid(),
  workforce_budget_id uuid not null references payroll_workforce_budgets(id),
  line_number integer not null check (line_number between 1 and 500),
  employee_id uuid references payroll_employees(id),
  position_name text check (position_name is null or (length(position_name) between 1 and 100 and position_name = btrim(position_name))),
  pay_basis text not null check (pay_basis in ('salary', 'hourly')),
  fte numeric(5,4) check (fte is null or (fte > 0 and fte <= 1)),
  hours_per_week numeric(6,2) check (hours_per_week is null or (hours_per_week > 0 and hours_per_week <= 168)),
  kiwisaver_rate numeric(5,2) not null check (kiwisaver_rate between 0 and 100),
  start_month date not null check (extract(day from start_month) = 1),
  end_month date check (end_month is null or (extract(day from end_month) = 1 and end_month >= start_month)),
  check ((employee_id is null) <> (position_name is null)),
  check ((pay_basis = 'salary') = (fte is not null)),
  check ((pay_basis = 'hourly') = (hours_per_week is not null)),
  unique (workforce_budget_id, line_number)
);
create unique index payroll_workforce_budget_lines_employee_idx
  on payroll_workforce_budget_lines (workforce_budget_id, employee_id) where employee_id is not null;

-- Pay from a month: the first from the line's start month, later ones pay rises (decision 116).
create table payroll_workforce_budget_line_rates (
  line_id uuid not null references payroll_workforce_budget_lines(id) on delete cascade,
  from_month date not null check (extract(day from from_month) = 1),
  rate numeric(14,4) not null check (rate > 0),
  primary key (line_id, from_month)
);

-- A position's own split (decision 117); employees use their cost allocation.
create table payroll_workforce_budget_line_splits (
  line_id uuid not null references payroll_workforce_budget_lines(id) on delete cascade,
  split_number integer not null check (split_number between 1 and 20),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  department_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  primary key (line_id, split_number)
);

-- Budget amounts a workforce budget wrote (decision 113, 121).
alter table budget_amounts add column workforce_budget_id uuid references payroll_workforce_budgets(id);

-- Only the owning workforce budget's own rewrite (which sets
-- tohyee.workforce_budget_feed to its id for the transaction) may write,
-- change or release an amount it owns, or take one over.
create function tohyee_guard_budget_amount_workforce() returns trigger
language plpgsql as $$
declare
  feeding text := coalesce(current_setting('tohyee.workforce_budget_feed', true), '');
begin
  if tg_op = 'UPDATE' and old.workforce_budget_id is not null and feeding <> old.workforce_budget_id::text then
    raise exception 'This budget amount comes from a workforce budget; change it there' using errcode = 'P0001';
  end if;
  if new.workforce_budget_id is not null and feeding <> new.workforce_budget_id::text then
    raise exception 'Only the workforce budget itself can write its budget amounts' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger budget_amounts_workforce_guard
  before insert or update on budget_amounts
  for each row execute function tohyee_guard_budget_amount_workforce();
`,
  };
