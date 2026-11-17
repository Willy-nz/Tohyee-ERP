import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0074",
    name: "payroll_week_settings",
    sql: `
-- Two payroll settings (docs/DECISIONS.md 192, 199; examples TS12, PREP9):
-- the first day of the timesheet week (ISO 1 = Monday to 7 = Sunday; NetSuite's
-- "first day of week" preference), and the standard week FTE is measured
-- against (40.00 hours unless changed).
alter table organisation_settings
  add column payroll_timesheet_first_day smallint not null default 1 check (payroll_timesheet_first_day between 1 and 7),
  add column payroll_standard_week numeric(5,2) not null default 40.00 check (payroll_standard_week > 0 and payroll_standard_week <= 168);

-- A timesheet's week starts on the organisation's first day, not always a
-- Monday. The day can only change while there are no timesheets (checked
-- when settings are saved, and below), so every timesheet keeps to it.
alter table payroll_timesheets drop constraint payroll_timesheets_week_start_check;

create function tohyee_check_timesheet_week_start() returns trigger
language plpgsql as $$
declare
  first_day smallint;
begin
  select payroll_timesheet_first_day into first_day from organisation_settings where id = true;
  if extract(isodow from new.week_start) <> coalesce(first_day, 1) then
    raise exception 'A timesheet week starts on the organisation''s first day of the week (ISO day %)', coalesce(first_day, 1) using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_timesheets_week_start_check
  before insert or update of week_start on payroll_timesheets
  for each row execute function tohyee_check_timesheet_week_start();

create function tohyee_guard_timesheet_first_day() returns trigger
language plpgsql as $$
begin
  if new.payroll_timesheet_first_day <> old.payroll_timesheet_first_day and exists (select 1 from payroll_timesheets) then
    raise exception 'The first day of the timesheet week can''t change once there are timesheets' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger organisation_settings_timesheet_first_day_guard
  before update of payroll_timesheet_first_day on organisation_settings
  for each row execute function tohyee_guard_timesheet_first_day();
`,
  };
