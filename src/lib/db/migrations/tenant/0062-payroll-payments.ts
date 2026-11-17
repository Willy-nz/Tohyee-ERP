import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0062",
    name: "payroll_payments",
    sql: `
-- Payroll stage P4 (examples PPAY1-PPAY12): paying the net wages of an
-- approved pay run and paying IRD the deductions the pay runs credited.
-- Each payment posts one journal; it's undone only by voiding it (the exact
-- reversal). Payments are never edited or deleted.

-- How often the organisation pays IRD (PPAY4, PPAY9): monthly, or twice a
-- month for employers whose gross annual PAYE and ESCT is $500,000 or more.
alter table organisation_settings add column payroll_ird_payment_frequency text not null default 'monthly'
  check (payroll_ird_payment_frequency in ('monthly', 'twice_monthly'));

-- Wage payments (PPAY1-PPAY3): Dr wages payable, Cr the bank. For the whole
-- pay run (employee_id null) or one employee on it, never both on one run.
create table payroll_wage_payments (
  id uuid primary key default gen_random_uuid(),
  payment_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  pay_run_id uuid not null references payroll_pay_runs(id),
  employee_id uuid,
  payment_date date not null,
  bank_account_id bigint not null references accounts(id),
  amount numeric(16,2) not null check (amount > 0),
  journal_id bigint not null unique references ledger_journals(id),
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  foreign key (pay_run_id, employee_id) references payroll_pay_run_employees(pay_run_id, employee_id),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= payment_date)
);
create index payroll_wage_payments_run_idx on payroll_wage_payments (pay_run_id);

-- A payment is for an approved pay run, on or after its pay date, never more
-- than what's unpaid (in total, or for that employee), and a run is paid
-- either as a whole or per employee. The service checks first, with the pay
-- run locked; this keeps the rule if it doesn't.
create function tohyee_check_payroll_wage_payment() returns trigger
language plpgsql as $$
declare
  run record;
  net numeric;
  paid numeric;
begin
  select status, pay_date into run from payroll_pay_runs where id = new.pay_run_id;
  if run.status is distinct from 'approved' then
    raise exception 'Only an approved pay run''s wages can be paid' using errcode = 'P0001';
  end if;
  if new.payment_date < run.pay_date then
    raise exception 'A wage payment can''t be dated before its pay run''s pay date' using errcode = 'P0001';
  end if;
  if exists (select 1 from payroll_wage_payments p
              where p.pay_run_id = new.pay_run_id and p.status = 'active' and (p.employee_id is null) <> (new.employee_id is null)) then
    raise exception 'A pay run is paid either as a whole or per employee, not both' using errcode = 'P0001';
  end if;
  select coalesce(sum(net_pay), 0) into net from payroll_pay_run_employees
   where pay_run_id = new.pay_run_id and (new.employee_id is null or employee_id = new.employee_id);
  select coalesce(sum(amount), 0) into paid from payroll_wage_payments
   where pay_run_id = new.pay_run_id and status = 'active' and (new.employee_id is null or employee_id = new.employee_id);
  if paid + new.amount > net then
    raise exception 'A wage payment can''t be more than the net pay left to pay' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_wage_payments_check
  before insert on payroll_wage_payments
  for each row execute function tohyee_check_payroll_wage_payment();

-- Payments are never edited or deleted; the only change is voiding one, once.
create function tohyee_guard_payroll_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payroll payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
         = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                  'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Payroll payments can''t be changed; void them instead' using errcode = 'P0001';
end;
$$;
create trigger payroll_wage_payments_guard
  before update or delete on payroll_wage_payments
  for each row execute function tohyee_guard_payroll_payment();
create trigger payroll_wage_payments_no_truncate
  before truncate on payroll_wage_payments
  for each statement execute function tohyee_payroll_forbid_delete('Payroll payments can''t be deleted; void them instead');

-- IRD payroll payments (PPAY4-PPAY9): for one IRD period (by pay date), Dr
-- each liability paid, Cr the bank. Lines are the liabilities and amounts.
create table payroll_ird_payments (
  id uuid primary key default gen_random_uuid(),
  payment_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  frequency text not null check (frequency in ('monthly', 'twice_monthly')),
  period_start date not null,
  period_end date not null,
  payment_date date not null,
  bank_account_id bigint not null references accounts(id),
  amount numeric(16,2) not null check (amount > 0),
  journal_id bigint not null unique references ledger_journals(id),
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (period_end >= period_start),
  check (payment_date >= period_start),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= payment_date)
);
create index payroll_ird_payments_period_idx on payroll_ird_payments (period_start, period_end);
create trigger payroll_ird_payments_guard
  before update or delete on payroll_ird_payments
  for each row execute function tohyee_guard_payroll_payment();
create trigger payroll_ird_payments_no_truncate
  before truncate on payroll_ird_payments
  for each statement execute function tohyee_payroll_forbid_delete('Payroll payments can''t be deleted; void them instead');

create table payroll_ird_payment_lines (
  ird_payment_id uuid not null references payroll_ird_payments(id),
  liability text not null check (liability in ('paye', 'student_loan', 'kiwisaver', 'esct')),
  account_id bigint not null references accounts(id),
  amount numeric(16,2) not null check (amount > 0),
  primary key (ird_payment_id, liability)
);
create trigger payroll_ird_payment_lines_append_only
  before update or delete on payroll_ird_payment_lines
  for each row execute function tohyee_payroll_append_only('IRD payment lines');
create trigger payroll_ird_payment_lines_no_truncate
  before truncate on payroll_ird_payment_lines
  for each statement execute function tohyee_payroll_append_only('IRD payment lines');

-- An IRD payment's lines add up to it (checked at commit).
create function tohyee_check_payroll_ird_payment_total() returns trigger
language plpgsql as $$
declare
  payment_id uuid;
  expected numeric;
  total numeric;
  line_count integer;
begin
  if tg_table_name = 'payroll_ird_payment_lines' then
    payment_id := (to_jsonb(new) ->> 'ird_payment_id')::uuid;
  else
    payment_id := (to_jsonb(new) ->> 'id')::uuid;
  end if;
  select amount into expected from payroll_ird_payments where id = payment_id;
  select coalesce(sum(amount), 0), count(*) into total, line_count from payroll_ird_payment_lines where ird_payment_id = payment_id;
  if line_count = 0 or total <> expected then
    raise exception 'An IRD payment''s lines must add up to its amount' using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger payroll_ird_payments_total
  after insert on payroll_ird_payments deferrable initially deferred
  for each row execute function tohyee_check_payroll_ird_payment_total();
create constraint trigger payroll_ird_payment_lines_total
  after insert on payroll_ird_payment_lines deferrable initially deferred
  for each row execute function tohyee_check_payroll_ird_payment_total();

-- A pay run can't be voided while it has active wage payments, or while an
-- active IRD payment pays the period its pay date is in (PPAY3, PPAY12).
create function tohyee_check_payroll_pay_run_void() returns trigger
language plpgsql as $$
begin
  if old.status = 'approved' and new.status = 'voided' then
    if exists (select 1 from payroll_wage_payments where pay_run_id = old.id and status = 'active') then
      raise exception 'A pay run with wage payments can''t be voided; void the payments first' using errcode = 'P0001';
    end if;
    if exists (select 1 from payroll_ird_payments
                where status = 'active' and period_start <= old.pay_date and period_end >= old.pay_date) then
      raise exception 'A pay run whose IRD period has IRD payments can''t be voided; void the IRD payments first' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger payroll_pay_runs_void_check
  before update on payroll_pay_runs
  for each row execute function tohyee_check_payroll_pay_run_void();
`,
  };
