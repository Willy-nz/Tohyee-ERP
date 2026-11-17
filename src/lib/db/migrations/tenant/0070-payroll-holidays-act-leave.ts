import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0070",
    name: "payroll_holidays_act_leave",
    sql: `
-- Payroll stage P8 (docs/ACCOUNTING-EXAMPLES.md HL1-HL42, decisions 7-29
-- and 138 on): Holidays Act 2003 leave, built as a dated rule-set that ends
-- at each employee's first pay period starting on or after 6 Aug 2028.
-- Every leave entry stores its hours and the hours in one unit (a usual week
-- or a usual day) so balances stay exact and can move to the Employment
-- Leave Act 2026 (decisions 8, 26).

-- The organisation's anniversary day (decision 22) and a policy not to
-- consider cash-ups (s 28E).
alter table organisation_settings add column payroll_anniversary_region text
  check (payroll_anniversary_region is null or payroll_anniversary_region in ('auckland', 'taranaki', 'hawkes_bay', 'wellington',
    'marlborough', 'nelson', 'canterbury', 'canterbury_south', 'westland', 'otago', 'southland', 'chatham_islands'));
alter table organisation_settings add column payroll_no_cash_ups boolean not null default false;

-- Files kept with leave records: cash-up requests and answers (decision 29),
-- agreements (unpaid leave counting, holidays in advance, exchanging an
-- alternative holiday). Never changed or deleted (kept 6 years, s 81(4)).
create table payroll_leave_files (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references payroll_employees(id),
  purpose text not null check (purpose in ('cash_up_request', 'cash_up_answer', 'unpaid_leave_agreement', 'advance_agreement',
                                           'exchange_agreement')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null,
  byte_size integer not null check (byte_size > 0),
  sha256 text not null,
  content bytea not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null
);
create index payroll_leave_files_employee_idx on payroll_leave_files (employee_id);
create trigger payroll_leave_files_append_only
  before update or delete on payroll_leave_files
  for each row execute function tohyee_payroll_append_only('Leave files');
create trigger payroll_leave_files_no_truncate
  before truncate on payroll_leave_files
  for each statement execute function tohyee_payroll_append_only('Leave files');

-- Each employee's usual week and leave settings, dated (decisions 8, 9, 11,
-- 13, 19, 22; s 17, s 27(1)(a)). Never changed: a change is a new row from
-- a date, as pay rates are (PE7).
create table payroll_leave_settings (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  pattern_kind text not null check (pattern_kind in ('fixed', 'varies')),
  -- Seven days, Monday first: ordinary hours and usual extras (overtime, allowances), each regular or not.
  pattern_days jsonb,
  week_hours numeric(7,2) check (week_hours is null or week_hours > 0),
  week_days numeric(4,2) check (week_days is null or (week_days > 0 and week_days <= 7)),
  daily_pay text not null check (daily_pay in ('rdp', 'adp')),
  adp_reason text check (adp_reason is null or adp_reason in ('not_practicable', 'varies_within_period')),
  annual_paid_in_period boolean not null,
  part_day_sick_agreed boolean not null default false,
  employment_type text not null default 'continuous' check (employment_type in ('continuous', 'casual')),
  anniversary_region text
    check (anniversary_region is null or anniversary_region in ('auckland', 'taranaki', 'hawkes_bay', 'wellington',
      'marlborough', 'nelson', 'canterbury', 'canterbury_south', 'westland', 'otago', 'southland', 'chatham_islands')),
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  check ((pattern_kind = 'fixed') = (pattern_days is not null and jsonb_typeof(pattern_days) = 'array' and jsonb_array_length(pattern_days) = 7)),
  check ((pattern_kind = 'varies') = (week_hours is not null and week_days is not null)),
  check ((daily_pay = 'adp') = (adp_reason is not null))
);
create index payroll_leave_settings_employee_idx on payroll_leave_settings (employee_id, effective_from, entry_number);
create trigger payroll_leave_settings_append_only
  before update or delete on payroll_leave_settings
  for each row execute function tohyee_payroll_append_only('Leave settings');
create trigger payroll_leave_settings_no_truncate
  before truncate on payroll_leave_settings
  for each statement execute function tohyee_payroll_append_only('Leave settings');

-- Unpaid leave (s 16(2), s 16(3); decision 14). A single period of other
-- unpaid leave longer than a week moves the anniversary unless a written
-- agreement to count it is recorded.
create table payroll_unpaid_leave (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  start_date date not null,
  end_date date not null,
  reason text not null check (reason in ('other', 'sick', 'bereavement', 'family_violence', 'parental', 'volunteers', 'acc')),
  agreed_to_count boolean not null default false,
  agreement_file_id uuid references payroll_leave_files(id),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (end_date >= start_date),
  check (not agreed_to_count or (reason = 'other' and agreement_file_id is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payroll_unpaid_leave_employee_idx on payroll_unpaid_leave (employee_id, start_date);

-- Leave booked for an employee (annual holidays, sick, bereavement and
-- family violence leave, alternative holidays). Pay runs for the days it
-- covers pay it; a booking a pay run has paid can't be cancelled.
create table payroll_leave_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  leave_type text not null check (leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative')),
  start_date date not null,
  end_date date not null,
  -- Hours each day for someone whose hours vary: {"2026-11-04": "6.5", …}.
  day_hours jsonb,
  -- A part day of sick or family violence leave: the hours worked that day (decision 19).
  hours_worked numeric(5,2) check (hours_worked is null or hours_worked > 0),
  bereavement_kind text check (bereavement_kind is null or bereavement_kind in ('close_family', 'pregnancy_loss', 'other')),
  -- Sick, bereavement or family violence leave in advance, agreed (s 63(3), s 72D(3)).
  in_advance_agreed boolean not null default false,
  -- The written agreement to recover annual holidays taken in advance (decision 15), when there is one.
  advance_agreement_file_id uuid references payroll_leave_files(id),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (end_date >= start_date),
  check (end_date <= start_date + 366),
  check (hours_worked is null or (start_date = end_date and leave_type in ('sick', 'family_violence'))),
  check ((leave_type = 'bereavement') = (bereavement_kind is not null)),
  check (leave_type <> 'alternative' or start_date = end_date),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payroll_leave_bookings_employee_idx on payroll_leave_bookings (employee_id, start_date) where status = 'booked';

-- Whether a public holiday would otherwise have been a working day, and the
-- hours worked on it (decisions 21, 23): decided by the person running pay
-- and recorded. A decision an approved pay run used can't change.
create table payroll_public_holiday_decisions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references payroll_employees(id),
  holiday_date date not null,
  holiday_name text not null,
  otherwise_working boolean not null,
  -- Tohyee's suggestion and why, for someone whose hours vary (decision 21).
  suggestion text check (suggestion is null or length(suggestion) <= 200),
  hours_worked numeric(5,2) check (hours_worked is null or (hours_worked > 0 and hours_worked <= 24)),
  -- s 50(1)(b): an identifiable penal rate an hour in the agreement.
  penal_hourly_rate numeric(12,4) check (penal_hourly_rate is null or penal_hourly_rate > 0),
  -- A typed extra the agreement gives (decision 23).
  extra_amount numeric(16,2) check (extra_amount is null or extra_amount > 0),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'current' check (status in ('current', 'replaced')),
  decided_at timestamptz not null default now(),
  decided_by_user_id uuid,
  decided_by_email text not null,
  check (hours_worked is null or penal_hourly_rate is null or hours_worked > 0)
);
create unique index payroll_public_holiday_decisions_current_idx on payroll_public_holiday_decisions (employee_id, holiday_date)
  where status = 'current';

-- Cash-ups of annual holidays (s 28A-s 28F; decision 29): only with the
-- employee's written request and the employer's written answer attached.
create table payroll_cash_ups (
  id uuid primary key default gen_random_uuid(),
  cash_up_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  requested_on date not null,
  agreed_on date not null,
  weeks numeric(12,8) not null check (weeks > 0 and weeks <= 1),
  hours numeric(12,4) not null check (hours > 0),
  week_hours numeric(7,2) not null check (week_hours > 0),
  request_file_id uuid not null references payroll_leave_files(id),
  answer_file_id uuid not null references payroll_leave_files(id),
  status text not null default 'agreed' check (status in ('agreed', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (agreed_on >= requested_on),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payroll_cash_ups_employee_idx on payroll_cash_ups (employee_id);

-- Alternative holidays exchanged for payment (s 61; decision 24).
create table payroll_alternative_exchanges (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  arose_on date not null,
  requested_on date not null,
  agreed_on date not null,
  default_amount numeric(16,2) not null check (default_amount >= 0),
  amount numeric(16,2) not null check (amount > 0),
  agreement_note text not null check (length(btrim(agreement_note)) between 1 and 1000),
  agreement_file_id uuid references payroll_leave_files(id),
  status text not null default 'agreed' check (status in ('agreed', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (requested_on >= arose_on + interval '12 months'),
  check (agreed_on >= requested_on),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

-- Leave pay items (decision 138): one per kind, made by Tohyee, each with its
-- own account so reports show annual holidays, sick leave and the rest
-- apart. Leave taken in the pay period is ordinary pay for PAYE (IRD's
-- operational position on holiday pay, 2016); cash-ups and exchanged
-- alternative holidays are extra pays (decision 151). Family violence leave
-- is "Special leave" so payslips and journals don't say what it is
-- (decision 27).
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payroll_pay_items'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) like '%''holiday_pay''%'
                   or pg_get_constraintdef(oid) like '%is_system%'
                   or pg_get_constraintdef(oid) like '%''termination_holiday_pay''%') loop
    execute format('alter table payroll_pay_items drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table payroll_pay_items add constraint payroll_pay_items_kind_check
  check (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay', 'back_pay',
                  'termination_holiday_pay', 'redundancy', 'after_tax_deduction', 'kiwisaver_employer',
                  'annual_leave', 'sick_leave', 'bereavement_leave', 'family_violence_leave', 'public_holiday',
                  'public_holiday_worked', 'alternative_holiday', 'annual_leave_cash_up', 'alternative_holiday_payout'));
alter table payroll_pay_items add constraint payroll_pay_items_earnings_check
  check ((category = 'earnings') = (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay',
                                              'back_pay', 'termination_holiday_pay', 'redundancy', 'annual_leave', 'sick_leave',
                                              'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked',
                                              'alternative_holiday', 'annual_leave_cash_up', 'alternative_holiday_payout')));
alter table payroll_pay_items add constraint payroll_pay_items_extra_pay_check
  check ((kind not in ('extra_pay', 'back_pay', 'termination_holiday_pay', 'annual_leave_cash_up', 'alternative_holiday_payout')
          or (subject_to_paye and subject_to_acc_levy and subject_to_kiwisaver))
         and (kind <> 'redundancy' or (subject_to_paye and not subject_to_acc_levy and not subject_to_kiwisaver)));
alter table payroll_pay_items add constraint payroll_pay_items_leave_check
  check (kind not in ('holiday_pay', 'annual_leave', 'sick_leave', 'bereavement_leave', 'family_violence_leave', 'public_holiday',
                      'public_holiday_worked', 'alternative_holiday')
         or (subject_to_paye and subject_to_acc_levy and subject_to_kiwisaver));
alter table payroll_pay_items add constraint payroll_pay_items_ordinary_check
  check (kind not in ('ordinary_time', 'overtime') or (subject_to_paye and subject_to_kiwisaver));
alter table payroll_pay_items add constraint payroll_pay_items_system_check
  check (not is_system or (kind in ('ordinary_time', 'kiwisaver_employer', 'termination_holiday_pay', 'annual_leave', 'sick_leave',
                                    'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked',
                                    'alternative_holiday', 'annual_leave_cash_up', 'alternative_holiday_payout')
                           and not is_archived));

-- Gross earnings for holiday pay (s 14; decision 139): what counts in
-- average weekly earnings, average daily pay and the 8%. Reimbursements,
-- non-taxable allowances, redundancy (Employment NZ: "generally ...
-- compensation and not earnings") and cash-ups (s 14(c)(iv)) don't;
-- an extra pay or allowance the employer isn't bound to pay is marked
-- discretionary when it's added (s 14(b)(i)).
alter table payroll_pay_items add column counts_for_holiday_pay boolean;
update payroll_pay_items
   set counts_for_holiday_pay = category = 'earnings' and subject_to_paye and kind not in ('redundancy', 'annual_leave_cash_up');
alter table payroll_pay_items alter column counts_for_holiday_pay set not null;
alter table payroll_pay_items add constraint payroll_pay_items_holiday_gross_check
  check ((not counts_for_holiday_pay or (category = 'earnings' and subject_to_paye))
         and (kind not in ('redundancy', 'annual_leave_cash_up', 'reimbursement') or not counts_for_holiday_pay)
         and (kind not in ('ordinary_time', 'overtime', 'holiday_pay', 'back_pay', 'termination_holiday_pay', 'annual_leave',
                           'sick_leave', 'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked',
                           'alternative_holiday', 'alternative_holiday_payout') or counts_for_holiday_pay));

-- The starting pay items (0058) with the new column, for organisations made from now on.
create or replace function tohyee_seed_payroll_pay_items() returns void
language plpgsql as $$
declare
  wages bigint := (select id from accounts where lower(code) = '6200' and account_class = 'expense' and currency_code is null);
  kiwisaver bigint := (select id from accounts where lower(code) = '6210' and account_class = 'expense' and currency_code is null);
  general bigint := (select id from accounts where lower(code) = '6070' and account_class = 'expense' and currency_code is null);
  deductions bigint := (select id from accounts where system_key = 'payroll_deductions_payable');
begin
  if exists (select 1 from payroll_pay_items) then
    return;
  end if;
  insert into payroll_pay_items (
    idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
    subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, is_system,
    counts_for_holiday_pay
  ) values
    ('system:ordinary-time', 'system', 'Ordinary time', 'earnings', 'ordinary_time', wages, null, true, true, true, true, false, true, true),
    ('system:overtime', 'system', 'Overtime', 'earnings', 'overtime', wages, 1.5, true, true, true, true, false, false, true),
    ('system:allowance', 'system', 'Allowance (taxable)', 'earnings', 'allowance', wages, null, true, true, true, true, false, false, true),
    ('system:holiday-pay', 'system', 'Holiday pay', 'earnings', 'holiday_pay', wages, null, true, true, true, true, false, false, true),
    ('system:reimbursement', 'system', 'Reimbursement', 'earnings', 'reimbursement', general, null, false, false, false, false, false, false,
     false),
    ('system:union-fees', 'system', 'Union fees', 'deduction', 'after_tax_deduction', deductions, null, false, false, false, false, false, false,
     false),
    ('system:kiwisaver-employer', 'system', 'KiwiSaver employer contribution', 'employer_contribution', 'kiwisaver_employer', kiwisaver, null,
     false, false, false, false, true, true, false);
end;
$$;

create function tohyee_seed_payroll_leave_items() returns void
language plpgsql as $$
declare
  wages bigint := (select id from accounts where lower(code) = '6200' and account_class = 'expense' and currency_code is null);
  item record;
  wanted text;
  suffix integer;
begin
  if not exists (select 1 from payroll_pay_items) then
    return;
  end if;
  for item in select * from (values
      ('annual_leave', 'Annual leave', false),
      ('sick_leave', 'Sick leave', false),
      ('bereavement_leave', 'Bereavement leave', false),
      ('family_violence_leave', 'Special leave', false),
      ('public_holiday', 'Public holiday', false),
      ('public_holiday_worked', 'Public holiday worked', false),
      ('alternative_holiday', 'Alternative holiday', false),
      ('annual_leave_cash_up', 'Annual leave cashed up', true),
      ('alternative_holiday_payout', 'Alternative holiday paid out', true),
      ('termination_holiday_pay', 'Holiday pay owed on finishing', true)) as v(kind, name, extra) loop
    if exists (select 1 from payroll_pay_items where is_system and kind = item.kind) then
      continue;
    end if;
    wanted := item.name;
    suffix := 1;
    while exists (select 1 from payroll_pay_items where lower(name) = lower(wanted)) loop
      suffix := suffix + 1;
      wanted := item.name || ' (' || suffix || ')';
    end loop;
    insert into payroll_pay_items (
      idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
      subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, is_system,
      counts_for_holiday_pay
    ) values ('system:' || replace(item.kind, '_', '-'), 'system', wanted, 'earnings', item.kind, wages, null,
              true, true, true, true, false, true, item.kind <> 'annual_leave_cash_up');
  end loop;
end;
$$;
select tohyee_seed_payroll_leave_items();

-- Leave on pay run lines. A line is typed, part of the usual pay Tohyee
-- made from the usual week, or leave Tohyee worked out (decision 141).
-- Leave lines keep the dates, hours, units and the rate and its inputs
-- (decision 8), and what they pay (a booking, a public holiday, a cash-up,
-- an exchange, holiday pay on finishing). "regular" marks overtime and
-- allowances that are a regular part of pay (s 8(1)(b); decision 11).
alter table payroll_pay_run_lines add column source text not null default 'typed'
  check (source in ('typed', 'usual_pay', 'leave'));
alter table payroll_pay_run_lines add column regular boolean;
alter table payroll_pay_run_lines add column leave_type text
  check (leave_type is null or leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative', 'public_holiday',
                                              'public_holiday_worked', 'cash_up', 'exchange', 'termination'));
alter table payroll_pay_run_lines add column leave_booking_id uuid references payroll_leave_bookings(id);
alter table payroll_pay_run_lines add column leave_from date;
alter table payroll_pay_run_lines add column leave_to date;
alter table payroll_pay_run_lines add column leave_hours numeric(12,4) check (leave_hours is null or leave_hours >= 0);
alter table payroll_pay_run_lines add column leave_unit_hours numeric(12,4) check (leave_unit_hours is null or leave_unit_hours > 0);
alter table payroll_pay_run_lines add column leave_units numeric(16,8);
alter table payroll_pay_run_lines add column leave_in_advance boolean not null default false;
alter table payroll_pay_run_lines add column holiday_date date;
alter table payroll_pay_run_lines add column cash_up_id uuid references payroll_cash_ups(id);
alter table payroll_pay_run_lines add column exchange_id uuid references payroll_alternative_exchanges(id);
alter table payroll_pay_run_lines add column leave_basis jsonb;
alter table payroll_pay_run_lines add constraint payroll_pay_run_lines_leave_check
  check ((source = 'leave') = (leave_type is not null)
         and (source <> 'leave' or (quantity is null and back_pay_for_pay_run_id is null))
         and ((leave_hours is null) = (leave_unit_hours is null)));
create index payroll_pay_run_lines_leave_idx on payroll_pay_run_lines (employee_id, leave_type) where leave_type is not null;
create index payroll_pay_run_lines_booking_idx on payroll_pay_run_lines (leave_booking_id) where leave_booking_id is not null;

-- What stops a draft's leave being worked out (shown with the employee and
-- blocking approval until it's fixed), set each time the leave is updated.
alter table payroll_pay_run_employees add column leave_problem text;
alter table payroll_pay_run_employees add column leave_notes jsonb;
`,
  };
