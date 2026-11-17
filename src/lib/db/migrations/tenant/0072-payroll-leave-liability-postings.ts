import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0072",
    name: "payroll_leave_liability_postings",
    sql: `
-- Posting the leave liability to the ledger (decision 177; decisions
-- 182-187; docs/ACCOUNTING-EXAMPLES.md HL52-HL56). The two accounts are
-- payroll settings. Each posting is the change since the last posting not
-- voided, Dr leave expense / Cr employee entitlements (or the other way),
-- by Department; it keeps the liability it posted to, by Department, so
-- the next one can measure from it. Voided with a reversing journal, never
-- changed or deleted.
alter table organisation_settings
  add column payroll_leave_expense_account_id bigint references accounts(id),
  add column payroll_leave_liability_account_id bigint references accounts(id);

create table payroll_leave_liability_postings (
  id uuid primary key default gen_random_uuid(),
  posting_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  as_at date not null,
  expense_account_id bigint not null references accounts(id),
  liability_account_id bigint not null references accounts(id),
  -- The liability at as_at (the report's total) and the change in it
  -- (0.00 when only its split between Departments changed).
  liability numeric(16,2) not null check (liability >= 0),
  change numeric(16,2) not null,
  -- The posting this one measured from (null for the first).
  previous_posting_id uuid references payroll_leave_liability_postings(id),
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
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= as_at)
);
create index payroll_leave_liability_postings_active_idx on payroll_leave_liability_postings (posting_number) where status = 'active';

-- The liability posted, by Department (null: no Department). Never changed.
create table payroll_leave_liability_departments (
  posting_id uuid not null references payroll_leave_liability_postings(id),
  line_number integer not null check (line_number > 0),
  department_id bigint references tracking_values(id),
  liability numeric(16,2) not null check (liability >= 0),
  primary key (posting_id, line_number)
);
create unique index payroll_leave_liability_departments_idx on payroll_leave_liability_departments (posting_id, coalesce(department_id, 0));
create trigger payroll_leave_liability_departments_append_only
  before update or delete on payroll_leave_liability_departments
  for each row execute function tohyee_payroll_append_only('Leave liability postings');
create trigger payroll_leave_liability_departments_no_truncate
  before truncate on payroll_leave_liability_departments
  for each statement execute function tohyee_payroll_append_only('Leave liability postings');

create function tohyee_guard_leave_liability_posting() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Leave liability postings can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
         = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                  'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Leave liability postings can''t be changed; void them instead' using errcode = 'P0001';
end;
$$;
create trigger payroll_leave_liability_postings_guard
  before update or delete on payroll_leave_liability_postings
  for each row execute function tohyee_guard_leave_liability_posting();
create trigger payroll_leave_liability_postings_no_truncate
  before truncate on payroll_leave_liability_postings
  for each statement execute function tohyee_payroll_forbid_delete('Leave liability postings can''t be deleted; void them instead');
`,
  };
