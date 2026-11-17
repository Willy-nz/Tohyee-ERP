import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0073",
    name: "payroll_leave_liability_kiwisaver",
    sql: `
-- Employer KiwiSaver on the leave liability (decision 190;
-- docs/ACCOUNTING-EXAMPLES.md HL59, HL60): each posting keeps the employer
-- KiwiSaver (gross, before ESCT) on the liability it posted, in total and by
-- Department, beside the holiday pay, so the next posting can measure each
-- from it. Postings before this measured none (0.00). ADD COLUMN with a
-- default fires no row triggers, so the append-only guards are untouched.
alter table payroll_leave_liability_postings
  add column kiwisaver numeric(16,2) not null default 0 check (kiwisaver >= 0);
alter table payroll_leave_liability_departments
  add column kiwisaver numeric(16,2) not null default 0 check (kiwisaver >= 0);
`,
  };
