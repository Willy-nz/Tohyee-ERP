import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0313",
  name: "tax_rate_zero_and_maori_authority",
  sql: `
-- A tax depreciation rate of 0% is allowed (TXF2): it's IRD's rate for
-- buildings, and a new commercial or industrial building at 0% can still
-- get Investment Boost.
alter table fixed_asset_tax_details drop constraint fixed_asset_tax_details_rate_check;
alter table fixed_asset_tax_details add constraint fixed_asset_tax_details_rate_check
  check (rate is null or (rate >= 0 and rate <= 100 and scale(rate) <= 4));
-- Beneficiary income that comes from a Maori authority distribution isn't
-- caught by the minor beneficiary rule (TXF7).
alter table trust_beneficiary_income add column from_maori_authority boolean not null default false;
`,
};
