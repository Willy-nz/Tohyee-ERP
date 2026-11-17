import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0107",
    name: "payroll_kiwisaver_temporary_rate_reduction",
    sql: `
-- A KiwiSaver temporary rate reduction approved by IRD, with the dates on
-- IRD's approval (example PR13b, review issue #141). Approving a pay run keeps
-- it with the pay, like the bank account (PSLIP7).
alter table payroll_employees
  add column kiwisaver_reduction_from date,
  add column kiwisaver_reduction_to date,
  add constraint payroll_employees_kiwisaver_reduction_dates check (
    (kiwisaver_reduction_from is null) = (kiwisaver_reduction_to is null)
    and (kiwisaver_reduction_to is null or kiwisaver_reduction_to >= kiwisaver_reduction_from)
  );
alter table payroll_pay_run_employees
  add column kiwisaver_reduction_from date,
  add column kiwisaver_reduction_to date;
`,
  };
