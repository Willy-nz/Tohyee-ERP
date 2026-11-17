import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0106",
    name: "payroll_details_changed_on_drafts",
    sql: `
-- Changing an employee counts as preparing their draft pay runs (example
-- PRUN7b, review issue #140): who changed whose payroll details while a pay
-- run was a draft, so "approver must be different" refuses them too.
alter table payroll_pay_runs add column details_changed_by jsonb not null default '[]'::jsonb;
`,
  };
