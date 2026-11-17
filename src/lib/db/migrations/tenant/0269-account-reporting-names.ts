import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0269",
    name: "account_reporting_names",
    sql: `
-- A name for financial reports and statements, instead of the account's own
-- name (RN1-RN3, decision 1582). Null: the account's name.
alter table accounts add column reporting_name text check (reporting_name is null or length(reporting_name) between 1 and 200);
`,
  };
