import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0132",
    name: "rd_income_year_early_balance_date",
    sql: `
-- R&D income years for an early balance date (October to March) now count
-- toward the tax year ending the 31 March after the balance date, as IRD
-- numbers them and as livestock already did (#243, decided 13 Oct 2026; IRD
-- SPS 08/04's examples). Before, a year ending 30 November 2025 was 2025; now
-- it's 2026. January to September are unchanged, and October to December
-- year ends are the ones that move, so their saved years move forward one.
-- The guard and stamp triggers are paused only for this renumbering.
do $$
begin
  if (select financial_year_end_month from organisation_settings where id = true) >= 10 then
    alter table rd_activities disable trigger user;
    update rd_activities set first_income_year = first_income_year + 1, last_income_year = last_income_year + 1;
    alter table rd_activities enable trigger user;
    alter table rd_approvals disable trigger user;
    update rd_approvals set first_income_year = first_income_year + 1, last_income_year = last_income_year + 1;
    alter table rd_approvals enable trigger user;
    alter table rd_asset_tax_depreciation disable trigger user;
    update rd_asset_tax_depreciation set income_year = income_year + 1;
    alter table rd_asset_tax_depreciation enable trigger user;
  end if;
end
$$;
`,
  };
