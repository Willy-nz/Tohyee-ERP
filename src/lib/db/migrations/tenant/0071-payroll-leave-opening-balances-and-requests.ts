import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0071",
    name: "payroll_leave_opening_balances_and_requests",
    sql: `
-- Opening leave balances (decision 168; docs/ACCOUNTING-EXAMPLES.md
-- HL43-HL48): an employee's leave and earlier earnings from another
-- payroll, as at the end of the opening date, entered once (a replacement
-- keeps the old one) with where they came from and the previous system's
-- report attached. Employees' own leave requests (decision 169; HL49-HL51).
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payroll_leave_files'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%cash_up_request%' loop
    execute format('alter table payroll_leave_files drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table payroll_leave_files add constraint payroll_leave_files_purpose_check
  check (purpose in ('cash_up_request', 'cash_up_answer', 'unpaid_leave_agreement', 'advance_agreement', 'exchange_agreement',
                     'opening_balances_report'));

create table payroll_leave_opening_balances (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  as_at date not null,
  -- Annual holidays in weeks (negative when taken in advance) and the usual week's hours they're in (decision 8).
  annual_weeks numeric(12,8) not null,
  annual_week_hours numeric(7,2) not null check (annual_week_hours > 0),
  annual_last_entitled date check (annual_last_entitled is null or annual_last_entitled <= as_at),
  annual_cashed_up_weeks numeric(12,8) not null default 0 check (annual_cashed_up_weeks >= 0 and annual_cashed_up_weeks <= 1),
  annual_advance_paid numeric(16,2) not null default 0 check (annual_advance_paid >= 0),
  sick_days numeric(10,4) not null,
  family_violence_days numeric(10,4) not null,
  -- The dates untaken alternative holidays arose (s 81(2)(k)).
  alternative_holidays date[] not null default '{}',
  source text not null check (length(btrim(source)) between 1 and 1000),
  report_file_id uuid not null references payroll_leave_files(id),
  status text not null default 'current' check (status in ('current', 'replaced')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  replaced_at timestamptz,
  replaced_by_email text,
  check ((annual_weeks < 0) = (annual_advance_paid > 0)),
  check ((status = 'replaced') = (replaced_at is not null))
);
create unique index payroll_leave_opening_balances_current_idx on payroll_leave_opening_balances (employee_id) where status = 'current';

-- The earlier earnings, one row per pay period of the previous payroll:
-- gross earnings (s 14), the irregular part (s 8(2)), days worked or on
-- paid leave (s 9A(2)). Never changed.
create table payroll_leave_opening_earnings (
  opening_id uuid not null references payroll_leave_opening_balances(id),
  line_number integer not null check (line_number > 0),
  period_start date not null,
  period_end date not null,
  gross numeric(16,2) not null check (gross >= 0),
  irregular numeric(16,2) not null default 0 check (irregular >= 0 and irregular <= gross),
  days integer not null check (days >= 0 and days <= period_end - period_start + 1),
  primary key (opening_id, line_number),
  check (period_end >= period_start and period_end - period_start <= 30)
);
create trigger payroll_leave_opening_earnings_append_only
  before update or delete on payroll_leave_opening_earnings
  for each row execute function tohyee_payroll_append_only('Opening earnings');
create trigger payroll_leave_opening_earnings_no_truncate
  before truncate on payroll_leave_opening_earnings
  for each statement execute function tohyee_payroll_append_only('Opening earnings');

-- Leave asked for by employees (decision 169): hours and days only, never
-- pay. Approving books the leave (payroll_leave_bookings) as the approver.
create table payroll_leave_requests (
  id uuid primary key default gen_random_uuid(),
  request_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  leave_type text not null check (leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative')),
  start_date date not null,
  end_date date not null,
  day_hours jsonb,
  bereavement_kind text check (bereavement_kind is null or bereavement_kind in ('close_family', 'pregnancy_loss', 'other')),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid not null,
  created_by_email text not null,
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by_user_id uuid,
  decided_by_email text,
  rejection_reason text check (rejection_reason is null or length(btrim(rejection_reason)) between 1 and 1000),
  booking_id uuid references payroll_leave_bookings(id),
  check (end_date >= start_date and end_date <= start_date + 366),
  check ((leave_type = 'bereavement') = (bereavement_kind is not null)),
  check (leave_type <> 'alternative' or start_date = end_date),
  check ((status in ('approved', 'rejected')) = (decided_at is not null and decided_by_email is not null)),
  check ((status = 'approved') = (booking_id is not null)),
  check ((status = 'rejected') = (rejection_reason is not null)),
  check (decided_by_user_id is null or decided_by_user_id <> created_by_user_id)
);
create index payroll_leave_requests_employee_idx on payroll_leave_requests (employee_id, start_date);
create index payroll_leave_requests_pending_idx on payroll_leave_requests (status) where status = 'pending';
`,
  };
