import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0078",
    name: "payroll_pay_run_bank_account",
    sql: `
-- The bank account each approved pay paid into (decision 262; PSLIP7),
-- encrypted as on the employee, so a payslip shows where that pay went
-- even after the employee changes account. Null for pays approved before
-- this (their payslips show the employee's current account, as before).
alter table payroll_pay_run_employees add column bank_account_ciphertext text;
`,
  };
