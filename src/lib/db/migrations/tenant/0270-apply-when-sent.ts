import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0270",
    name: "apply_when_sent",
    sql: `
-- Orders chosen with "Apply Sales when sent to orders already invoiced"
-- (SWS13, decision 1583): the next sync holds what's still to be sent.
alter table sales_platform_documents add column apply_when_sent boolean not null default false;
`,
  };
