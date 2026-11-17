import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0182",
    name: "farm_reporting",
    sql: `
-- Farm-level reporting (#390, FR1-FR8, decision 743): as Xero does it, a
-- tracking category carries the farm. Farming settings name the category;
-- each farm is linked to at most one of its values (values under it count
-- for the farm). Each farm's own physical figures for a year sit beside the
-- organisation's (farm_year_figures). Nothing here posts.
alter table farming_settings add column farm_tracking_category_id bigint references tracking_categories(id);
alter table farms add column tracking_value_id bigint references tracking_values(id);
create unique index farms_tracking_value on farms (tracking_value_id) where tracking_value_id is not null;

create table farm_year_figures_by_farm (
  farm_id bigint not null references farms(id),
  year_end date not null,
  effective_ha numeric(12, 2) check (effective_ha is null or effective_ha > 0),
  peak_cows integer check (peak_cows is null or peak_cows > 0),
  stock_units numeric(12, 1) check (stock_units is null or stock_units > 0),
  milk_solids_kg numeric(14, 1) check (milk_solids_kg is null or milk_solids_kg > 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (farm_id, year_end)
);
`,
  };
