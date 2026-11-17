import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0277",
    name: "farm_weather_days",
    sql: `
-- Each farm's daily rain and mean temperature from MetService (FW1-FW8,
-- decision 1597; Jess, 12 Nov 2026: "use MetService and their history").
-- Worked out once a day is over from the forecasts Tohyee keeps (each hour
-- from the forecast fetched closest before it), and from MetService's five
-- days of recent history to fill gaps. Only while the organisation keeps
-- MetService records and allows combining them with farm data.
create table farm_weather_days (
  farm_id bigint not null references farms(id),
  day date not null,
  source text not null check (source in ('metservice')),
  rain_mm numeric(6,1) check (rain_mm is null or rain_mm between 0 and 2000),
  temperature_c numeric(4,1) check (temperature_c is null or temperature_c between -60 and 60),
  hours integer not null check (hours between 1 and 24),
  worked_out_at timestamptz not null default now(),
  primary key (farm_id, day, source)
);
create table farm_weather_state (
  id boolean primary key default true check (id),
  last_backfill_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500)
);
-- A modelled-cover line may also use the rain and temperature before the picture (MCV9).
alter table vegetation_cover_models add column rain_coefficient numeric(12,4);
alter table vegetation_cover_models add column temperature_coefficient numeric(12,4);
`,
  };
