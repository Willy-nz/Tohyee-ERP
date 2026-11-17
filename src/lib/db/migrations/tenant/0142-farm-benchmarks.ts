import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0142",
    name: "farm_benchmarks",
    sql: `
-- Farm benchmarks (#259, examples FK1-FK4): expense accounts grouped as farm
-- working expenses, and each year's physical figures, so the year's
-- expenses can be shown per kg of milk solids, hectare, cow and stock unit.
-- Nothing here posts.
create table farm_expense_groups (
  account_id bigint primary key references accounts(id),
  group_key text not null check (group_key in (
    'wages', 'animal_health', 'breeding', 'farm_dairy', 'electricity', 'feed', 'grazing', 'fertiliser',
    'irrigation', 'regrassing', 'weed_pest', 'vehicles', 'repairs', 'freight', 'administration',
    'insurance', 'rates', 'other')),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

create table farm_year_figures (
  year_end date primary key,
  effective_ha numeric(12, 2) check (effective_ha is null or effective_ha > 0),
  peak_cows integer check (peak_cows is null or peak_cows > 0),
  stock_units numeric(12, 1) check (stock_units is null or stock_units > 0),
  milk_solids_kg numeric(14, 1) check (milk_solids_kg is null or milk_solids_kg > 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
`,
  };
