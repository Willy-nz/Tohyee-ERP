import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0038",
    name: "opening_balance_account_name",
    sql: `
-- The account opening balances clear through is called "Opening balance",
-- like NetSuite's Opening Balance account (Jess, 30 Sep 2026). Only the
-- starting name changes; an account someone has renamed keeps its name.
update accounts
   set name = 'Opening balance', updated_at = now()
 where system_key = 'conversion_clearing'
   and name = 'Historical adjustment';
`,
  };
