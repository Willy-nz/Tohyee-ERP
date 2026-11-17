import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0151",
    name: "fixed_asset_tax_details",
    sql: `
-- Tax depreciation and Investment Boost (examples ITX11-ITX18, decision
-- 546): a fixed asset's tax details. Nothing here posts.
create table fixed_asset_tax_details (
  asset_id bigint primary key references fixed_assets(id),
  method text not null check (method in ('dv', 'sl', 'low_value', 'not_depreciable')),
  rate numeric check (rate is null or (rate > 0 and rate <= 100 and scale(rate) <= 4)),
  check ((method in ('dv', 'sl')) = (rate is not null)),
  tax_cost numeric(18, 2) not null check (tax_cost > 0),
  business_use_percent numeric not null default 100 check (business_use_percent > 0 and business_use_percent <= 100 and scale(business_use_percent) <= 2),
  available_on date not null,
  new_asset boolean not null default false,
  investment_boost boolean not null default false,
  check (not investment_boost or (new_asset and method in ('dv', 'sl') and available_on >= date '2025-05-22')),
  check (method <> 'low_value' or tax_cost <= 1000),
  opening_income_year integer check (opening_income_year is null or opening_income_year between 2000 and 2100),
  opening_atv numeric(18, 2) check (opening_atv is null or opening_atv >= 0),
  check ((opening_income_year is null) = (opening_atv is null)),
  check (opening_atv is null or opening_atv <= tax_cost),
  version integer not null default 1,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  };
