import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0051",
    name: "payroll_employees",
    sql: `
create table payroll_employees (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text not null check (length(btrim(last_name)) between 1 and 100),
  email text check (email is null or length(email) <= 320),
  phone text check (phone is null or length(phone) <= 50),
  postal_address text check (postal_address is null or length(postal_address) <= 1000),
  date_of_birth date,
  tax_code text not null check (tax_code ~ '^[A-Z0-9]+( [A-Z0-9]+)*$' and length(tax_code) <= 20),
  ird_number_ciphertext text not null,
  kiwisaver_status text not null
    check (kiwisaver_status in ('enrolled', 'not_enrolled', 'opted_out', 'savings_suspension', 'not_eligible')),
  kiwisaver_employee_rate numeric(5,2) not null
    check (kiwisaver_employee_rate between 0 and 100),
  kiwisaver_employer_rate numeric(5,2) not null
    check (kiwisaver_employer_rate between 0 and 100),
  student_loan boolean not null,
  pay_frequency text not null
    check (pay_frequency in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  pay_basis text not null check (pay_basis in ('salary', 'hourly')),
  annual_salary numeric(16,2),
  hourly_rate numeric(16,2),
  ordinary_hours_per_week numeric(7,2),
  start_date date not null,
  finish_date date,
  bank_account_ciphertext text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (finish_date is null or finish_date >= start_date),
  check (
    (pay_basis = 'salary' and annual_salary > 0 and hourly_rate is null and ordinary_hours_per_week is null)
    or (pay_basis = 'hourly' and annual_salary is null and hourly_rate > 0 and ordinary_hours_per_week > 0)
  )
);

create index payroll_employees_active_name
  on payroll_employees (lower(last_name), lower(first_name))
  where not is_archived;

create function tohyee_payroll_employee_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'Payroll employee records can''t be deleted or truncated; archive the employee instead' using errcode = 'P0001';
end;
$$;
create trigger payroll_employees_no_delete
  before delete on payroll_employees
  for each row execute function tohyee_payroll_employee_forbid_delete();
create trigger payroll_employees_no_truncate
  before truncate on payroll_employees
  for each statement execute function tohyee_payroll_employee_forbid_delete();
`,
  };
