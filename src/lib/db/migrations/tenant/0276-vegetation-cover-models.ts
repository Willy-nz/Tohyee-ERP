import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0276",
    name: "vegetation_cover_models",
    sql: `
-- Modelled pasture cover from satellite greenness (#612 phase 3, MCV7,
-- decision 1596): the line a farm's admin turned on, as it was checked, with
-- the error they chose to accept. At most one in use a farm. Estimates are
-- worked out when read; none is saved as a reading.
create table vegetation_cover_models (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  intercept numeric(12,4) not null,
  slope numeric(12,4) not null,
  ndvi_min numeric(5,4) not null,
  ndvi_max numeric(5,4) not null,
  likely_within integer not null check (likely_within >= 0),
  mean_error integer not null check (mean_error >= 0),
  bias integer not null,
  acceptable_error integer not null check (acceptable_error between 10 and 3000),
  pairs integer not null check (pairs > 0),
  dates integer not null check (dates > 0),
  validation jsonb not null,
  turned_on_by_email text not null,
  turned_on_at timestamptz not null default now(),
  turned_off_by_email text,
  turned_off_at timestamptz,
  check (mean_error <= acceptable_error)
);
create unique index vegetation_cover_models_in_use on vegetation_cover_models (farm_id) where turned_off_at is null;
`,
  };
