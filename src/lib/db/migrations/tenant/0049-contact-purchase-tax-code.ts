import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0049",
    name: "contact_purchase_tax_code",
    sql: `
-- A contact's own default purchase tax code (EX16-EX25), like Xero's contact
-- "Purchase defaults" tax rate and the default sales tax code (EX5). New
-- purchase lines start with it; saved documents never change. Existing
-- contacts have none, so nothing changes for them (EX16).
alter table contacts add column default_purchase_tax_code_id bigint references tax_codes(id);
`,
  };
