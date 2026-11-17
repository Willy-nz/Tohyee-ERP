import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0160",
    name: "sick_leave_expectations",
    sql: `
-- Sick leave expected to be used from carried-over leave (#310 item 4;
-- example HL62, decision 564; NZ IAS 19 / PBE IPSAS 39 paras 16-17). Each
-- row is an assessment from a date; the latest on or before the report's
-- date applies. Never edited: a new assessment replaces it.
create table payroll_sick_leave_expectations (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  days numeric(6,2) not null check (days >= 0),
  reason text check (reason is null or length(reason) between 1 and 500),
  check (days = 0 or reason is not null),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index payroll_sick_leave_expectations_employee on payroll_sick_leave_expectations (employee_id, effective_from);
create trigger payroll_sick_leave_expectations_no_delete before delete on payroll_sick_leave_expectations for each row execute function toeyee_forbid_delete();
`,
  };
