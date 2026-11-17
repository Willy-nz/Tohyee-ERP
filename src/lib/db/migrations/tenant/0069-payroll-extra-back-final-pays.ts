import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0069",
    name: "payroll_extra_back_final_pays",
    sql: `
-- Payroll stage P12 (docs/ACCOUNTING-EXAMPLES.md XP1-XP14; docs/DECISIONS.md
-- 124-137): extra pays, back pay and final pays.

-- New pay item kinds (decision 125): extra pays and back pay, and on a final
-- pay holiday pay on finishing (worked out outside Tohyee until leave, P8)
-- and redundancy, which has no ACC earners' levy and doesn't count for
-- KiwiSaver (spec 5.11.1 step 4.1, 4.5.1). The checks that listed the kinds,
-- and the one that tied the levy to PAYE, are replaced.
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payroll_pay_items'::regclass and contype = 'c'
              and ((pg_get_constraintdef(oid) like '%''holiday_pay''%' and pg_get_constraintdef(oid) like '%''reimbursement''%')
                   or pg_get_constraintdef(oid) like '%subject_to_acc_levy = subject_to_paye%') loop
    execute format('alter table payroll_pay_items drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table payroll_pay_items add constraint payroll_pay_items_kind_check
  check (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay', 'back_pay',
                  'termination_holiday_pay', 'redundancy', 'after_tax_deduction', 'kiwisaver_employer'));
alter table payroll_pay_items add constraint payroll_pay_items_earnings_check
  check ((category = 'earnings') = (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay',
                                              'back_pay', 'termination_holiday_pay', 'redundancy')));
alter table payroll_pay_items add constraint payroll_pay_items_taxes_check
  check (subject_to_student_loan = subject_to_paye
         and (subject_to_acc_levy = subject_to_paye or kind = 'redundancy'));
alter table payroll_pay_items add constraint payroll_pay_items_extra_pay_check
  check ((kind not in ('extra_pay', 'back_pay', 'termination_holiday_pay')
          or (subject_to_paye and subject_to_acc_levy and subject_to_kiwisaver))
         and (kind <> 'redundancy' or (subject_to_paye and not subject_to_acc_levy and not subject_to_kiwisaver)));

-- Back pay worked out from pay rate history (decision 133) keeps the
-- approved pay run it's for, so it isn't paid twice.
alter table payroll_pay_run_lines add column back_pay_for_pay_run_id uuid references payroll_pay_runs(id);
alter table payroll_pay_run_lines add constraint payroll_pay_run_lines_back_pay_check
  check (back_pay_for_pay_run_id is null or (quantity is null and amount > 0));
create index payroll_pay_run_lines_back_pay_idx on payroll_pay_run_lines (back_pay_for_pay_run_id, employee_id)
  where back_pay_for_pay_run_id is not null;

-- What approving kept about extra pays and final pays (decisions 127-130,
-- 134): the extra pays, their tax (part of paye), the rate and annualised
-- income they were taxed with, the lump sum indicator (EI field 14) and
-- the finish date of a final pay. Null on pay runs approved before P12.
alter table payroll_pay_run_employees add column extra_pay numeric(16,2) check (extra_pay is null or extra_pay >= 0);
alter table payroll_pay_run_employees add column extra_pay_tax numeric(16,2) check (extra_pay_tax is null or extra_pay_tax >= 0);
alter table payroll_pay_run_employees add column extra_pay_tax_rate numeric(5,2);
alter table payroll_pay_run_employees add column extra_pay_method text
  check (extra_pay_method is null or extra_pay_method in ('four_weeks', 'end_of_employment', 'flat_rate'));
alter table payroll_pay_run_employees add column extra_pay_annualised numeric(18,4);
alter table payroll_pay_run_employees add column lump_sum_lowest_rate boolean;
alter table payroll_pay_run_employees add column finish_date date;
`,
  };
