import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0006",
    name: "report_viewer_role",
    sql: `
-- Report viewers (decision 360): someone, such as a client, who signs in and
-- sees only the Analytics dashboards shared with them, nothing of the books.
alter table organisation_members drop constraint organisation_members_role_check;
alter table organisation_members add constraint organisation_members_role_check
  check (role in ('owner', 'admin', 'bookkeeper', 'viewer', 'report_viewer'));
`,
  };
