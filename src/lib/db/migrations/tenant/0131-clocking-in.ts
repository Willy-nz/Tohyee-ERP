import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0131",
    name: "clocking_in",
    sql: `
-- Clocking in (examples RS5-RS8, approved by Jess 8 and 12 Oct 2026,
-- decision 512; Deputy). Employees clock in and out with a PIN on a shared
-- device at the shop, login or not, with no location recorded. Clocked time
-- goes onto the employee's timesheet as "other work", marked from clock-in,
-- for their approver to approve as any timesheet. A shift not clocked out
-- by midnight needs a manager to enter the out time first.
alter table payroll_employees
  add column clock_pin_hash text,
  add column clock_pin_failures integer not null default 0 check (clock_pin_failures >= 0),
  add column clock_pin_locked_until timestamptz;

-- A shared device: its secret is kept only as a hash; the device holds it in a cookie.
create table payroll_clock_devices (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_email text,
  check ((revoked_at is null) = (revoked_by_email is null))
);

create table payroll_clock_records (
  id bigserial primary key,
  employee_id uuid not null references payroll_employees(id),
  device_id bigint references payroll_clock_devices(id),
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  break_started_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  -- RS8: who entered a missed clock-out, and why.
  out_entered_by_email text,
  out_reason text check (out_reason is null or length(out_reason) between 1 and 500),
  timesheet_entry_id uuid references payroll_timesheet_entries(id),
  -- Why the time isn't on the timesheet yet (its week is submitted or approved).
  timesheet_problem text,
  created_at timestamptz not null default now(),
  check (clock_out_at is null or clock_out_at > clock_in_at),
  check (clock_out_at is null or break_started_at is null),
  check ((out_entered_by_email is null) = (out_reason is null))
);
create unique index payroll_clock_records_open on payroll_clock_records (employee_id) where clock_out_at is null;
create index payroll_clock_records_employee on payroll_clock_records (employee_id, clock_in_at);

alter table payroll_timesheet_entries add column from_clock_in boolean not null default false;
`,
  };
