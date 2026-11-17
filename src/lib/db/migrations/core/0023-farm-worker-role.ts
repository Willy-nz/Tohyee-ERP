import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0023",
    name: "farm_worker_role",
    sql: `
-- Farm staff (#447, decision 904): record field work on their assigned farms
-- (decision 744) and see nothing of the books.
alter table organisation_members drop constraint organisation_members_role_check;
alter table organisation_members add constraint organisation_members_role_check
  check (role in ('owner', 'admin', 'bookkeeper', 'viewer', 'report_viewer', 'sales_manager', 'sales_rep', 'farm_worker'));
`,
  };
