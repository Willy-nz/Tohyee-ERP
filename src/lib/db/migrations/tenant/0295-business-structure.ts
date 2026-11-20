import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0295",
    name: "business_structure",
    sql: `
-- Settings › Business structure (examples ENT1-ENT8): what kind of entity the
-- organisation is, and its IRD number (9 digits, a leading 0 for 8).
alter table organisation_settings add column entity_type text check (
  entity_type in ('sole_trader', 'partnership', 'company', 'look_through_company', 'trust', 'incorporated_society')
);
alter table organisation_settings add column ird_number text check (ird_number ~ '^[0-9]{9}$');
`,
};
