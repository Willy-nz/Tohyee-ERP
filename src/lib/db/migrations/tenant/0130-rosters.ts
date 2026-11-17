import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0130",
    name: "rosters",
    sql: `
-- Rosters inside Payroll (examples RS1-RS4, approved by Jess 8 and 12 Oct
-- 2026, decision 511; Deputy). An area (such as the shop) has a weekly
-- roster budget; each week's roster has shifts for employees. Publishing
-- keeps a copy of the shifts, which is what employees see; changes after
-- that are shown against it until published again. Nothing is posted.
create table payroll_roster_areas (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  weekly_budget numeric check (weekly_budget is null or (weekly_budget >= 0 and scale(weekly_budget) <= 2)),
  is_active boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create unique index payroll_roster_areas_name on payroll_roster_areas (lower(name));

create table payroll_rosters (
  id bigserial primary key,
  area_id bigint not null references payroll_roster_areas(id),
  week_start date not null,
  published_at timestamptz,
  published_by_email text,
  published_shifts jsonb,
  created_at timestamptz not null default now(),
  unique (area_id, week_start),
  check ((published_at is null) = (published_shifts is null))
);

create table payroll_roster_shifts (
  id bigserial primary key,
  roster_id bigint not null references payroll_rosters(id),
  employee_id uuid not null references payroll_employees(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  break_minutes integer not null default 0 check (break_minutes between 0 and 600),
  -- Why the shift stands although the employee said they're unavailable (RS2).
  unavailable_reason text check (unavailable_reason is null or length(unavailable_reason) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  check (extract(epoch from (ends_at - starts_at)) / 60 > break_minutes)
);
create index payroll_roster_shifts_roster on payroll_roster_shifts (roster_id) where status = 'active';
create index payroll_roster_shifts_employee on payroll_roster_shifts (employee_id, starts_at) where status = 'active';

-- When an employee can't work (RS2): every week on a weekday, or between two dates.
create table payroll_unavailability (
  id bigserial primary key,
  employee_id uuid not null references payroll_employees(id),
  weekday integer check (weekday is null or weekday between 1 and 7),
  from_date date,
  to_date date,
  note text check (note is null or length(note) <= 500),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((weekday is null) <> (from_date is null)),
  check ((from_date is null) = (to_date is null)),
  check (to_date is null or to_date >= from_date)
);
create index payroll_unavailability_employee on payroll_unavailability (employee_id) where status = 'active';
`,
  };
