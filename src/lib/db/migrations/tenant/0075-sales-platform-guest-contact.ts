import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0075",
    name: "sales_platform_guest_contact",
    sql: `
-- Guest checkouts (decision 317; docs/ACCOUNTING-EXAMPLES.md SPC24): an
-- order without a platform customer goes to one contact chosen on the
-- connection. Null: guest checkouts are refused, as before.
alter table sales_platform_connections
  add column guest_contact_id bigint references contacts(id);
`,
  };
