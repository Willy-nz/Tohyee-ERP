import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0013",
    name: "sales_roles",
    sql: `
-- CRM-only roles (decision 491, #216): sales reps and sales managers use the
-- CRM and nothing of the books.
alter table organisation_members drop constraint organisation_members_role_check;
alter table organisation_members add constraint organisation_members_role_check
  check (role in ('owner', 'admin', 'bookkeeper', 'viewer', 'report_viewer', 'sales_manager', 'sales_rep'));
`,
  };
