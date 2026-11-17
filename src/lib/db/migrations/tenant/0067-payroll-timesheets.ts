import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0067",
    name: "payroll_timesheets",
    sql: `
-- Payroll stage P9 (docs/ACCOUNTING-EXAMPLES.md TS1-TS11; docs/DECISIONS.md
-- 91-101): weekly timesheets of hours by R&D activity, Department or
-- project, stamped by the database and never overwritten, approved by a
-- manager; approved pay runs keep the shares their costs were split by.
-- 0066 is taken by the CRM branch.

-- An employee's own login (decision 95) and their timesheet approver
-- (decision 96), both members' user ids in the core database.
alter table payroll_employees
  add column user_id uuid,
  add column timesheet_approver_user_id uuid,
  add constraint payroll_employees_not_own_timesheet_approver
    check (timesheet_approver_user_id is null or user_id is null or timesheet_approver_user_id <> user_id);
create unique index payroll_employees_user_idx on payroll_employees (user_id) where user_id is not null and not is_archived;

-- One timesheet per employee per week, Monday to Sunday (decision 92).
-- Draft -> submitted -> approved; rejected back to draft; reopened from
-- approved to draft only while no approved pay run has used it (decision 97).
create table payroll_timesheets (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved')),
  version integer not null default 1 check (version > 0),
  submitted_at timestamptz,
  submitted_by_user_id uuid,
  submitted_by_email text,
  approved_at timestamptz,
  approved_by_user_id uuid,
  approved_by_email text,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, week_start),
  check ((status = 'draft') = (submitted_at is null)),
  check ((status = 'approved') = (approved_at is not null)),
  check (submitted_at is null or submitted_by_email is not null),
  check (approved_at is null or approved_by_email is not null)
);
create index payroll_timesheets_status_idx on payroll_timesheets (status, week_start);

-- Each cell of the week: hours on a day against an R&D activity, a
-- Department, a project, any combination, or none ("other work", spread by
-- the default allocation). entered_at is the database's time (decision 94).
-- A change marks the old entry replaced and adds a new one; clearing a cell
-- marks it removed. Nothing is deleted.
create table payroll_timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references payroll_timesheets(id),
  work_date date not null,
  department_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  rd_activity_id uuid references rd_activities(id),
  hours numeric(4,2) not null check (hours > 0 and hours <= 24),
  description text check (description is null or (length(description) between 1 and 500 and description = btrim(description))),
  status text not null default 'active' check (status in ('active', 'replaced', 'removed')),
  replaces_id uuid unique references payroll_timesheet_entries(id),
  entered_at timestamptz not null default now(),
  entered_by_user_id uuid,
  entered_by_email text not null,
  ended_at timestamptz,
  ended_by_user_id uuid,
  ended_by_email text,
  check ((status = 'active') = (ended_at is null)),
  check (ended_at is null or ended_by_email is not null)
);
create unique index payroll_timesheet_entries_cell_idx on payroll_timesheet_entries (
  timesheet_id, work_date, coalesce(department_id, 0), coalesce(project_id, 0),
  coalesce(rd_activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where status = 'active';
create index payroll_timesheet_entries_sheet_idx on payroll_timesheet_entries (timesheet_id, work_date);

-- What happened to a timesheet, who did it and when (TS4).
create table payroll_timesheet_history (
  id bigserial primary key,
  timesheet_id uuid not null references payroll_timesheets(id),
  action text not null check (action in ('created', 'submitted', 'approved', 'rejected', 'reopened')),
  reason text check (reason is null or (length(reason) between 1 and 500 and reason = btrim(reason))),
  actor_user_id uuid,
  actor_email text not null,
  created_at timestamptz not null default now()
);
create index payroll_timesheet_history_sheet_idx on payroll_timesheet_history (timesheet_id, id);
create trigger payroll_timesheet_history_append_only
  before update or delete on payroll_timesheet_history
  for each row execute function tohyee_payroll_append_only('Timesheet history');
create trigger payroll_timesheet_history_no_truncate
  before truncate on payroll_timesheet_history
  for each statement execute function tohyee_payroll_append_only('Timesheet history');

-- The timesheets an approved pay run used (decision 98), and each
-- employee's shares of their costs: from a timesheet row or a line of the
-- default allocation, with its hours and weight (decisions 98, 100).
create table payroll_pay_run_timesheets (
  pay_run_id uuid not null references payroll_pay_runs(id),
  timesheet_id uuid not null references payroll_timesheets(id),
  primary key (pay_run_id, timesheet_id)
);
create index payroll_pay_run_timesheets_sheet_idx on payroll_pay_run_timesheets (timesheet_id);
create trigger payroll_pay_run_timesheets_append_only
  before update or delete on payroll_pay_run_timesheets
  for each row execute function tohyee_payroll_append_only('A pay run''s timesheets');
create trigger payroll_pay_run_timesheets_no_truncate
  before truncate on payroll_pay_run_timesheets
  for each statement execute function tohyee_payroll_append_only('A pay run''s timesheets');

create table payroll_pay_run_shares (
  pay_run_id uuid not null references payroll_pay_runs(id),
  employee_id uuid not null references payroll_employees(id),
  share_number integer not null check (share_number > 0),
  source text not null check (source in ('allocation', 'timesheet')),
  allocation_id uuid references payroll_cost_allocations(id),
  allocation_percentage numeric(5,2) check (allocation_percentage is null or (allocation_percentage > 0 and allocation_percentage <= 100)),
  hours numeric(8,2) check (hours is null or hours > 0),
  weight numeric not null check (weight > 0),
  percentage numeric(9,4) not null check (percentage >= 0 and percentage <= 100),
  tracking jsonb not null default '{}'::jsonb,
  department_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  rd_activity_id uuid references rd_activities(id),
  primary key (pay_run_id, employee_id, share_number),
  check ((source = 'timesheet') = (hours is not null)),
  check ((source = 'allocation') = (allocation_percentage is not null)),
  check (source = 'allocation' or allocation_id is null)
);
create index payroll_pay_run_shares_employee_idx on payroll_pay_run_shares (employee_id);
create trigger payroll_pay_run_shares_append_only
  before update or delete on payroll_pay_run_shares
  for each row execute function tohyee_payroll_append_only('Pay run shares');
create trigger payroll_pay_run_shares_no_truncate
  before truncate on payroll_pay_run_shares
  for each statement execute function tohyee_payroll_append_only('Pay run shares');

-- A posting's share of the pay and its percentage to 4 places (decision 101).
alter table payroll_pay_run_postings alter column percentage type numeric(9,4);
alter table payroll_pay_run_postings drop constraint payroll_pay_run_postings_percentage_check;
alter table payroll_pay_run_postings add constraint payroll_pay_run_postings_percentage_check check (percentage >= 0 and percentage <= 100);
alter table payroll_pay_run_postings add column share_number integer check (share_number is null or share_number > 0);

-- A timesheet's employee, week and creation never change; its status moves
-- only as decision 97 says; it's never deleted.
create function tohyee_guard_payroll_timesheet() returns trigger
language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Timesheets can''t be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.idempotency_key, new.request_hash, new.employee_id, new.week_start, new.created_by_user_id,
      new.created_by_email, new.created_at)
     is distinct from
     (old.id, old.idempotency_key, old.request_hash, old.employee_id, old.week_start, old.created_by_user_id,
      old.created_by_email, old.created_at) then
    raise exception 'A timesheet''s employee and week can''t change' using errcode = 'P0001';
  end if;
  if new.status = old.status then
    if old.status <> 'draft' and (new.version, new.submitted_at, new.approved_at) is distinct from (old.version, old.submitted_at, old.approved_at) then
      raise exception 'This timesheet is %, so it can''t change', old.status using errcode = 'P0001';
    end if;
    return new;
  end if;
  if not ((old.status = 'draft' and new.status = 'submitted')
          or (old.status = 'submitted' and new.status in ('approved', 'draft'))
          or (old.status = 'approved' and new.status = 'draft')) then
    raise exception 'A timesheet can''t go from % to %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and exists (
    select 1 from payroll_pay_run_timesheets l join payroll_pay_runs r on r.id = l.pay_run_id
     where l.timesheet_id = old.id and r.status = 'approved'
  ) then
    raise exception 'An approved pay run used this timesheet, so it can''t be reopened. Void the pay run first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_timesheets_guard
  before update or delete on payroll_timesheets
  for each row execute function tohyee_guard_payroll_timesheet();
create trigger payroll_timesheets_no_truncate
  before truncate on payroll_timesheets
  for each statement execute function tohyee_guard_payroll_timesheet();

-- Entries are stamped by the database, go only on a draft timesheet's
-- week, and change only by being replaced or removed (decision 94).
create function tohyee_guard_payroll_timesheet_entry() returns trigger
language plpgsql as $$
declare
  sheet record;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Timesheet entries can''t be deleted; clear the cell instead' using errcode = 'P0001';
  end if;
  select status, week_start into sheet from payroll_timesheets where id = new.timesheet_id for share;
  if sheet.status is distinct from 'draft' then
    raise exception 'This timesheet is %, so its hours can''t change', coalesce(sheet.status, 'missing') using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.entered_at := now();
    if new.status <> 'active' or new.ended_at is not null then
      raise exception 'A timesheet entry starts active' using errcode = 'P0001';
    end if;
    if new.work_date < sheet.week_start or new.work_date > sheet.week_start + 6 then
      raise exception 'The date % isn''t in the week starting %', new.work_date, sheet.week_start using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status <> 'active' or new.status not in ('replaced', 'removed')
     or (new.id, new.timesheet_id, new.work_date, new.department_id, new.project_id, new.rd_activity_id, new.hours,
         new.description, new.replaces_id, new.entered_at, new.entered_by_user_id, new.entered_by_email)
        is distinct from
        (old.id, old.timesheet_id, old.work_date, old.department_id, old.project_id, old.rd_activity_id, old.hours,
         old.description, old.replaces_id, old.entered_at, old.entered_by_user_id, old.entered_by_email) then
    raise exception 'A timesheet entry is kept as entered; change it by entering the new hours' using errcode = 'P0001';
  end if;
  new.ended_at := now();
  return new;
end;
$$;
create trigger payroll_timesheet_entries_guard
  before insert or update or delete on payroll_timesheet_entries
  for each row execute function tohyee_guard_payroll_timesheet_entry();
create trigger payroll_timesheet_entries_no_truncate
  before truncate on payroll_timesheet_entries
  for each statement execute function tohyee_guard_payroll_timesheet_entry();

-- A pay run uses only approved timesheets.
create function tohyee_check_payroll_pay_run_timesheet() returns trigger
language plpgsql as $$
begin
  -- Locked, so a reopen can't slip in before the pay run commits.
  perform 1 from payroll_timesheets where id = new.timesheet_id and status = 'approved' for share;
  if not found then
    raise exception 'A pay run can only use approved timesheets' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_pay_run_timesheets_approved
  before insert on payroll_pay_run_timesheets
  for each row execute function tohyee_check_payroll_pay_run_timesheet();
`,
  };
