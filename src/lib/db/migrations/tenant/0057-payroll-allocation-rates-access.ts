import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0057",
    name: "payroll_allocation_rates_access",
    sql: `
-- Payroll stage P1b (examples PE3-PE12): payroll access, pay groups and
-- employee groups, job details, pay rate history and cost allocations.
-- Nothing here posts to the ledger.

-- Payroll access (PE9-PE12): a permission an admin gives named members, kept
-- against their core user id. Grants and removals are in audit_events.
-- payroll_access_started_at records that the first owner was given it, so
-- it's only done once (PE9).
alter table organisation_settings add column payroll_access_started_at timestamptz;

create table payroll_access (
  user_id uuid primary key,
  granted_at timestamptz not null default now(),
  granted_by_user_id uuid,
  granted_by_email text not null check (length(granted_by_email) between 1 and 320)
);

-- Rows that are kept for ever: archived, never deleted (TG_ARGV[0] is the message).
create function tohyee_payroll_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception '%', tg_argv[0] using errcode = 'P0001';
end;
$$;

-- Pay groups (e.g. "Weekly wages", each with a pay frequency) and employee
-- groups for reporting (PE8).
create table payroll_pay_groups (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  pay_frequency text not null
    check (pay_frequency in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payroll_pay_groups_name_idx on payroll_pay_groups (lower(name));
create trigger payroll_pay_groups_no_delete
  before delete on payroll_pay_groups
  for each row execute function tohyee_payroll_forbid_delete('Pay groups can''t be deleted; archive them instead');
create trigger payroll_pay_groups_no_truncate
  before truncate on payroll_pay_groups
  for each statement execute function tohyee_payroll_forbid_delete('Pay groups can''t be deleted; archive them instead');

create table payroll_employee_groups (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payroll_employee_groups_name_idx on payroll_employee_groups (lower(name));
create trigger payroll_employee_groups_no_delete
  before delete on payroll_employee_groups
  for each row execute function tohyee_payroll_forbid_delete('Employee groups can''t be deleted; archive them instead');
create trigger payroll_employee_groups_no_truncate
  before truncate on payroll_employee_groups
  for each statement execute function tohyee_payroll_forbid_delete('Employee groups can''t be deleted; archive them instead');

-- Job details (PE8).
alter table payroll_employees
  add column job_title text check (job_title is null or length(btrim(job_title)) between 1 and 100),
  add column reports_to_id uuid references payroll_employees(id),
  add column pay_group_id uuid references payroll_pay_groups(id),
  add column employee_group_id uuid references payroll_employee_groups(id),
  add constraint payroll_employees_not_own_manager check (reports_to_id is null or reports_to_id <> id);
create index payroll_employees_pay_group_idx on payroll_employees (pay_group_id) where pay_group_id is not null;

-- An employee in a pay group is paid at the group's frequency, and a group's
-- frequency can't change while employees are in it (PE8).
create function tohyee_check_payroll_pay_group() returns trigger
language plpgsql as $$
declare
  group_frequency text;
begin
  if tg_table_name = 'payroll_employees' then
    if new.pay_group_id is not null then
      select pay_frequency into group_frequency from payroll_pay_groups where id = new.pay_group_id for share;
      if group_frequency is distinct from new.pay_frequency then
        raise exception 'An employee''s pay frequency must match their pay group''s' using errcode = 'P0001';
      end if;
    end if;
  elsif new.pay_frequency <> old.pay_frequency
        and exists (select 1 from payroll_employees where pay_group_id = new.id) then
    raise exception 'A pay group''s frequency can''t change while employees are in it' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_employees_pay_group
  before insert or update of pay_group_id, pay_frequency on payroll_employees
  for each row execute function tohyee_check_payroll_pay_group();
create trigger payroll_pay_groups_frequency
  before update of pay_frequency on payroll_pay_groups
  for each row execute function tohyee_check_payroll_pay_group();

-- Rows that are history: added, never changed or deleted.
create function tohyee_payroll_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% can''t be changed or deleted; save a new one instead', tg_argv[0] using errcode = 'P0001';
end;
$$;

-- Pay rate history (PE7). The rate in effect on a date is the one with the
-- latest effective_from on or before it; for the same date, the latest
-- entry_number (a correction).
create table payroll_pay_rates (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  pay_basis text not null check (pay_basis in ('salary', 'hourly')),
  annual_salary numeric(16,2),
  hourly_rate numeric(16,2),
  ordinary_hours_per_week numeric(7,2),
  reason text check (reason is null or length(btrim(reason)) between 1 and 200),
  idempotency_key text not null unique,
  request_hash text not null,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (
    (pay_basis = 'salary' and annual_salary > 0 and hourly_rate is null and ordinary_hours_per_week is null)
    or (pay_basis = 'hourly' and annual_salary is null and hourly_rate > 0 and ordinary_hours_per_week > 0)
  )
);
create index payroll_pay_rates_effective_idx on payroll_pay_rates (employee_id, effective_from, entry_number);
create trigger payroll_pay_rates_append_only
  before update or delete on payroll_pay_rates
  for each row execute function tohyee_payroll_append_only('Pay rates');
create trigger payroll_pay_rates_no_truncate
  before truncate on payroll_pay_rates
  for each statement execute function tohyee_payroll_append_only('Pay rates');

-- Every existing employee's pay becomes their first rate, from their start
-- date. From now on payroll_employees.pay_basis, annual_salary, hourly_rate
-- and ordinary_hours_per_week keep the pay the employee started on; the rate
-- history is where pay is read from.
insert into payroll_pay_rates (
  employee_id, effective_from, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
  reason, idempotency_key, request_hash, created_by_email
)
select id, start_date, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
       'Starting pay', 'starting-pay:' || id::text, 'migration-0057', 'system'
  from payroll_employees
 order by created_at, id;

-- Cost allocations (PE3-PE6): where an employee's pay is charged, split by %
-- across Department, Class and Location values, a project and (from the RDTI
-- register, a later stage) an R&D activity. Lines total exactly 100.00%,
-- checked at commit.
create table payroll_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  idempotency_key text not null unique,
  request_hash text not null,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index payroll_cost_allocations_effective_idx on payroll_cost_allocations (employee_id, effective_from, entry_number);

create table payroll_cost_allocation_lines (
  allocation_id uuid not null references payroll_cost_allocations(id),
  line_number integer not null check (line_number between 1 and 100),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  department_id bigint references tracking_values(id),
  class_id bigint references tracking_values(id),
  location_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  -- The R&D activity register is a later stage (R2); no foreign key yet.
  rd_activity_id uuid,
  primary key (allocation_id, line_number)
);
create unique index payroll_cost_allocation_lines_distinct_idx on payroll_cost_allocation_lines (
  allocation_id, coalesce(department_id, 0), coalesce(class_id, 0), coalesce(location_id, 0),
  coalesce(project_id, 0), coalesce(rd_activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create function tohyee_check_payroll_allocation_line() returns trigger
language plpgsql as $$
begin
  if new.department_id is not null and not exists (
    select 1 from tracking_values v join tracking_categories c on c.id = v.category_id
     where v.id = new.department_id and c.kind = 'department'
  ) then
    raise exception 'An allocation line''s department must be a Department value' using errcode = 'P0001';
  end if;
  if new.class_id is not null and not exists (
    select 1 from tracking_values v join tracking_categories c on c.id = v.category_id
     where v.id = new.class_id and c.kind = 'class'
  ) then
    raise exception 'An allocation line''s class must be a Class value' using errcode = 'P0001';
  end if;
  if new.location_id is not null and not exists (
    select 1 from tracking_values v join tracking_categories c on c.id = v.category_id
     where v.id = new.location_id and c.kind = 'location'
  ) then
    raise exception 'An allocation line''s location must be a Location value' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_cost_allocation_lines_tracking
  before insert on payroll_cost_allocation_lines
  for each row execute function tohyee_check_payroll_allocation_line();

create function tohyee_assert_payroll_allocation_total(target uuid) returns void
language plpgsql as $$
declare
  total numeric;
begin
  select coalesce(sum(percentage), 0) into total from payroll_cost_allocation_lines where allocation_id = target;
  if total <> 100 then
    raise exception 'A cost allocation''s lines must total exactly 100.00%% (these total %)', to_char(total, 'FM990.00') || '%'
      using errcode = '23514';
  end if;
end;
$$;
create function tohyee_check_payroll_allocation() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'payroll_cost_allocations' then
    perform tohyee_assert_payroll_allocation_total(new.id);
  else
    perform tohyee_assert_payroll_allocation_total(new.allocation_id);
  end if;
  return null;
end;
$$;
create constraint trigger payroll_cost_allocations_total
  after insert on payroll_cost_allocations
  deferrable initially deferred
  for each row execute function tohyee_check_payroll_allocation();
create constraint trigger payroll_cost_allocation_lines_total
  after insert on payroll_cost_allocation_lines
  deferrable initially deferred
  for each row execute function tohyee_check_payroll_allocation();

create trigger payroll_cost_allocations_append_only
  before update or delete on payroll_cost_allocations
  for each row execute function tohyee_payroll_append_only('Cost allocations');
create trigger payroll_cost_allocations_no_truncate
  before truncate on payroll_cost_allocations
  for each statement execute function tohyee_payroll_append_only('Cost allocations');
create trigger payroll_cost_allocation_lines_append_only
  before update or delete on payroll_cost_allocation_lines
  for each row execute function tohyee_payroll_append_only('Cost allocations');
create trigger payroll_cost_allocation_lines_no_truncate
  before truncate on payroll_cost_allocation_lines
  for each statement execute function tohyee_payroll_append_only('Cost allocations');
`,
  };
