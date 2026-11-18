import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0290",
    name: "payroll_add_on",
    sql: `
-- Payroll as an add-on of its own (examples PAO1-PAO9). It can be on with
-- Accounting off: pay runs are then worked out, paid by bank file and filed
-- with IRD, but nothing posts to the books. Existing organisations keep what
-- they had: payroll on where Accounting is on.
alter table organisation_settings add column payroll_enabled boolean not null default true;
update organisation_settings set payroll_enabled = false where accounting_enabled = false;
-- Payroll counts as an app that's on (PAO1).
alter table organisation_settings drop constraint organisation_settings_one_app_on,
  add constraint organisation_settings_one_app_on check (accounting_enabled or payroll_enabled or crm_enabled or analytics_enabled);

-- A pay run approved while Accounting was off has no journal, now or later
-- (PAO4): in_books says which kind it is.
alter table payroll_pay_runs add column in_books boolean not null default true;
do $$
declare found record;
begin
  for found in
    select conname from pg_constraint
     where conrelid = 'payroll_pay_runs'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) like '%approval_journal_id%' or pg_get_constraintdef(oid) like '%void_journal_id%')
  loop
    execute format('alter table payroll_pay_runs drop constraint %I', found.conname);
  end loop;
end $$;
alter table payroll_pay_runs
  add constraint payroll_pay_runs_approved_check check ((status = 'draft') = (approved_at is null)),
  add constraint payroll_pay_runs_journal_check check (
    case when in_books then (status = 'draft') = (approval_journal_id is null)
         else approval_journal_id is null and void_journal_id is null end),
  add constraint payroll_pay_runs_voided_check check (
    (status = 'voided') = (void_date is not null and voided_at is not null)
    and (status <> 'voided' or not in_books or void_journal_id is not null));

-- Without the books, each employee's costs are still kept by pay item,
-- department, project and R&D activity for payroll's reports (PAO7), with
-- the pay item's account if it has one, and no journal line.
alter table payroll_pay_run_postings alter column account_id drop not null, alter column journal_line_order drop not null;
`,
};
