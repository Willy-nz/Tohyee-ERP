import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0058",
    name: "payroll_pay_runs",
    sql: `
-- Payroll stage P3 (examples PRUN1-PRUN11): pay items, pay runs, and the
-- accounts an approved pay run posts to. Approving posts one journal dated
-- the pay date; approved pay runs are never changed, only voided.

-- The accounts pay runs credit (PRUN1), marked by role so they can be
-- renamed or re-coded. New organisations get them with the starting chart;
-- existing ones get them here, at the code shown or the next free one (an
-- existing 2200 liability is taken as PAYE payable).
update accounts set system_key = 'paye_payable', updated_at = now()
 where lower(code) = '2200' and account_class = 'liability' and system_key is null and currency_code is null
   and not exists (select 1 from accounts where system_key = 'paye_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2200, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'PAYE payable', 'liability', 'current_liability', 'paye_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'paye_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2210, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'KiwiSaver payable', 'liability', 'current_liability', 'kiwisaver_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'kiwisaver_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2220, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'ESCT payable', 'liability', 'current_liability', 'esct_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'esct_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2230, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Student loan payable', 'liability', 'current_liability', 'student_loan_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'student_loan_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2240, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Wages payable', 'liability', 'current_liability', 'wages_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'wages_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2250, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Payroll deductions payable', 'liability', 'current_liability', 'payroll_deductions_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'payroll_deductions_payable');

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll'));

-- PRUN7: optionally, whoever approves a pay run must not have prepared it.
alter table organisation_settings add column payroll_approver_must_differ boolean not null default false;

-- The employee's ESCT rate (spec 5.21), needed when they get employer
-- KiwiSaver contributions. Checked against IRD's bands for the pay date.
alter table payroll_employees add column esct_rate numeric(5,2) check (esct_rate is null or esct_rate between 0 and 100);

-- Pay items (PRUN10): earnings, after-tax deductions and the KiwiSaver
-- employer contribution, each with its account and its tax treatment per
-- IRD's spec. Taxable means PAYE, the ACC earners' levy and student loan
-- together; the kind fixes what can vary. An account can be missing (an
-- organisation whose chart didn't have it); pay runs refuse until it's set.
create table payroll_pay_items (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  category text not null check (category in ('earnings', 'deduction', 'employer_contribution')),
  kind text not null check (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement',
                                     'after_tax_deduction', 'kiwisaver_employer')),
  account_id bigint references accounts(id),
  rate_multiplier numeric(6,4) check (rate_multiplier is null or rate_multiplier > 0),
  subject_to_paye boolean not null,
  subject_to_acc_levy boolean not null,
  subject_to_student_loan boolean not null,
  subject_to_kiwisaver boolean not null,
  subject_to_esct boolean not null,
  is_system boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((category = 'earnings') = (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement'))),
  check ((category = 'deduction') = (kind = 'after_tax_deduction')),
  check ((category = 'employer_contribution') = (kind = 'kiwisaver_employer')),
  check (subject_to_acc_levy = subject_to_paye and subject_to_student_loan = subject_to_paye),
  check (not subject_to_kiwisaver or subject_to_paye),
  check (subject_to_esct = (category = 'employer_contribution')),
  check (kind not in ('ordinary_time', 'overtime', 'holiday_pay') or (subject_to_paye and subject_to_kiwisaver)),
  check (kind not in ('reimbursement', 'after_tax_deduction', 'kiwisaver_employer') or not subject_to_paye),
  check ((rate_multiplier is not null) = (kind = 'overtime')),
  check (not is_system or (kind in ('ordinary_time', 'kiwisaver_employer') and not is_archived))
);
create unique index payroll_pay_items_name_idx on payroll_pay_items (lower(name));
create unique index payroll_pay_items_system_idx on payroll_pay_items (kind) where is_system;
create trigger payroll_pay_items_no_delete
  before delete on payroll_pay_items
  for each row execute function tohyee_payroll_forbid_delete('Pay items can''t be deleted; archive them instead');
create trigger payroll_pay_items_no_truncate
  before truncate on payroll_pay_items
  for each statement execute function tohyee_payroll_forbid_delete('Pay items can''t be deleted; archive them instead');

-- The starting pay items (PRUN10), once, mapped to the starting chart's
-- accounts where the organisation has them. Called here for existing
-- organisations and by provisioning after the starting chart.
create function tohyee_seed_payroll_pay_items() returns void
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
    subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, is_system
  ) values
    ('system:ordinary-time', 'system', 'Ordinary time', 'earnings', 'ordinary_time', wages, null, true, true, true, true, false, true),
    ('system:overtime', 'system', 'Overtime', 'earnings', 'overtime', wages, 1.5, true, true, true, true, false, false),
    ('system:allowance', 'system', 'Allowance (taxable)', 'earnings', 'allowance', wages, null, true, true, true, true, false, false),
    ('system:holiday-pay', 'system', 'Holiday pay', 'earnings', 'holiday_pay', wages, null, true, true, true, true, false, false),
    ('system:reimbursement', 'system', 'Reimbursement', 'earnings', 'reimbursement', general, null, false, false, false, false, false, false),
    ('system:union-fees', 'system', 'Union fees', 'deduction', 'after_tax_deduction', deductions, null, false, false, false, false, false, false),
    ('system:kiwisaver-employer', 'system', 'KiwiSaver employer contribution', 'employer_contribution', 'kiwisaver_employer', kiwisaver, null,
     false, false, false, false, true, true);
end;
$$;
select tohyee_seed_payroll_pay_items() where exists (select 1 from accounts);

-- Pay runs (PRUN1-PRUN11): one pay group, one pay period, one pay date.
-- A draft can be changed or deleted; approving posts one journal and keeps
-- a copy of what each employee's pay was calculated from; voiding posts its
-- exact reversal. Only one pay run (not voided) per group and period.
create table payroll_pay_runs (
  id uuid primary key default gen_random_uuid(),
  run_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  pay_group_id uuid not null references payroll_pay_groups(id),
  pay_frequency text not null check (pay_frequency in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
  -- Everyone who created or changed the draft (PRUN7).
  prepared_by_user_ids uuid[] not null default '{}',
  approval_journal_id bigint unique references ledger_journals(id),
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (period_end >= period_start),
  check (pay_date >= period_start),
  check ((status = 'draft') = (approval_journal_id is null and approved_at is null)),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= pay_date)
);
create unique index payroll_pay_runs_period_idx on payroll_pay_runs (pay_group_id, period_start) where status <> 'voided';
create index payroll_pay_runs_pay_date_idx on payroll_pay_runs (pay_date desc, run_number desc);

-- Each employee on a pay run. While it's a draft, pay is calculated from
-- their current details; approving copies what it was calculated from and
-- the results here.
create table payroll_pay_run_employees (
  pay_run_id uuid not null references payroll_pay_runs(id),
  employee_id uuid not null references payroll_employees(id),
  employee_name text check (employee_name is null or length(employee_name) between 1 and 201),
  tax_code text,
  student_loan boolean,
  kiwisaver_status text,
  kiwisaver_employee_rate numeric(5,2),
  kiwisaver_employer_rate numeric(5,2),
  esct_rate numeric(5,2),
  gross numeric(16,2),
  taxable_earnings numeric(16,2),
  non_taxable_earnings numeric(16,2),
  kiwisaver_earnings numeric(16,2),
  paye numeric(16,2),
  student_loan_deduction numeric(16,2),
  kiwisaver_employee numeric(16,2),
  deductions numeric(16,2),
  net_pay numeric(16,2),
  kiwisaver_employer numeric(16,2),
  esct numeric(16,2),
  kiwisaver_employer_net numeric(16,2),
  employer_cost numeric(16,2),
  primary key (pay_run_id, employee_id)
);
create index payroll_pay_run_employees_employee_idx on payroll_pay_run_employees (employee_id);

-- Earnings and deductions per employee (PRUN2): hours x rate (rounded half
-- up once) or an amount.
create table payroll_pay_run_lines (
  pay_run_id uuid not null,
  employee_id uuid not null,
  line_number integer not null check (line_number between 1 and 200),
  pay_item_id uuid not null references payroll_pay_items(id),
  quantity numeric(10,2) check (quantity is null or quantity >= 0),
  rate numeric(18,6) check (rate is null or rate >= 0),
  amount numeric(16,2) not null check (amount >= 0),
  description text check (description is null or length(btrim(description)) between 1 and 200),
  primary key (pay_run_id, employee_id, line_number),
  foreign key (pay_run_id, employee_id) references payroll_pay_run_employees(pay_run_id, employee_id),
  check ((quantity is null) = (rate is null)),
  check (quantity is null or amount = round(quantity * rate, 2))
);

-- Each employee's share of each debit line of the pay run's journal
-- (PRUN1): who, which pay item, account, tracking and project. Only people
-- with payroll access see these; the journal shows totals.
create table payroll_pay_run_postings (
  pay_run_id uuid not null references payroll_pay_runs(id),
  posting_number integer not null check (posting_number > 0),
  employee_id uuid not null references payroll_employees(id),
  pay_item_id uuid not null references payroll_pay_items(id),
  account_id bigint not null references accounts(id),
  tracking jsonb not null default '{}'::jsonb,
  project_id bigint references projects(id),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  amount numeric(16,2) not null check (amount >= 0),
  journal_line_order integer not null check (journal_line_order > 0),
  primary key (pay_run_id, posting_number)
);
create index payroll_pay_run_postings_employee_idx on payroll_pay_run_postings (employee_id);
create trigger payroll_pay_run_postings_append_only
  before update or delete on payroll_pay_run_postings
  for each row execute function tohyee_payroll_append_only('Pay run postings');
create trigger payroll_pay_run_postings_no_truncate
  before truncate on payroll_pay_run_postings
  for each statement execute function tohyee_payroll_append_only('Pay run postings');

-- A draft can change; an approved pay run can only be voided; a voided one
-- never changes (PRUN6). Only drafts can be deleted.
create function tohyee_guard_payroll_pay_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'An approved or voided pay run can''t be deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (new.id, new.run_number, new.command_source, new.idempotency_key, new.request_hash, new.pay_group_id,
          new.pay_frequency, new.period_start, new.period_end, new.pay_date, new.created_by_user_id,
          new.created_by_email, new.prepared_by_user_ids, new.approval_journal_id, new.approve_command_source,
          new.approve_idempotency_key, new.approve_request_hash, new.approved_by_user_id, new.approved_by_email,
          new.approved_at, new.created_at)
         is not distinct from
         (old.id, old.run_number, old.command_source, old.idempotency_key, old.request_hash, old.pay_group_id,
          old.pay_frequency, old.period_start, old.period_end, old.pay_date, old.created_by_user_id,
          old.created_by_email, old.prepared_by_user_ids, old.approval_journal_id, old.approve_command_source,
          old.approve_idempotency_key, old.approve_request_hash, old.approved_by_user_id, old.approved_by_email,
          old.approved_at, old.created_at) then
    return new;
  end if;
  raise exception 'An approved or voided pay run can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger payroll_pay_runs_guard
  before update or delete on payroll_pay_runs
  for each row execute function tohyee_guard_payroll_pay_run();
create trigger payroll_pay_runs_no_truncate
  before truncate on payroll_pay_runs
  for each statement execute function tohyee_payroll_forbid_delete('Pay runs can''t be truncated');

-- An approved or voided pay run's employees and lines never change.
create function tohyee_guard_payroll_pay_run_detail() returns trigger
language plpgsql as $$
declare
  run_id uuid;
  run_status text;
begin
  if tg_op = 'DELETE' then
    run_id := old.pay_run_id;
  else
    run_id := new.pay_run_id;
  end if;
  select status into run_status from payroll_pay_runs where id = run_id;
  if run_status is not null and run_status <> 'draft' then
    raise exception 'An approved or voided pay run can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.pay_run_id <> old.pay_run_id then
    raise exception 'A pay run''s lines can''t move to another pay run' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger payroll_pay_run_employees_guard
  before insert or update or delete on payroll_pay_run_employees
  for each row execute function tohyee_guard_payroll_pay_run_detail();
create trigger payroll_pay_run_employees_no_truncate
  before truncate on payroll_pay_run_employees
  for each statement execute function tohyee_payroll_forbid_delete('Pay runs can''t be truncated');
create trigger payroll_pay_run_lines_guard
  before insert or update or delete on payroll_pay_run_lines
  for each row execute function tohyee_guard_payroll_pay_run_detail();
create trigger payroll_pay_run_lines_no_truncate
  before truncate on payroll_pay_run_lines
  for each statement execute function tohyee_payroll_forbid_delete('Pay runs can''t be truncated');
`,
  };
