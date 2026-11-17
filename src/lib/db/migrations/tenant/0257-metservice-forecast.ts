import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0257",
    name: "metservice_forecast",
    sql: `
-- MetService forecasts with the organisation's own key (decisions
-- 1541-1550; WX1-WX8). One settings row. The key is encrypted with the
-- server's TOHYEE_SECRET_KEY (a *_ciphertext column, so a restore re-wraps
-- it) and is never sent to a browser. Each farm has one point. Only the
-- latest forecast is kept, a row a farm, replaced each refresh and deleted
-- when the key goes, when MetService refuses the key, or when it's 24 hours
-- old: MetService's terms let it be stored only while it's needed.
create table weather_settings (
  id boolean primary key default true check (id),
  api_key_ciphertext text,
  key_saved_at timestamptz,
  key_saved_by_email text,
  setup_step text not null default 'about' check (setup_step in ('about', 'get_key', 'paste', 'test', 'farms', 'choose', 'turn_on')),
  choices text[] not null default array['rain', 'temperature', 'wind']::text[],
  refresh_hours integer not null default 3 check (refresh_hours in (1, 3, 6, 12)),
  enabled boolean not null default false,
  status text not null default 'not_tested' check (status in ('not_tested', 'ok', 'bad_key', 'no_units', 'not_allowed', 'rate_limited', 'error')),
  tested_at timestamptz,
  paused_at timestamptz,
  last_refresh_at timestamptz,
  last_manual_refresh_at timestamptz,
  units_charged_last integer,
  updated_at timestamptz not null default now(),
  check (not enabled or api_key_ciphertext is not null)
);
insert into weather_settings (id) values (true);

create table weather_locations (
  farm_id bigint primary key references farms(id),
  latitude numeric(9,6) not null check (latitude between -90 and 90),
  longitude numeric(9,6) not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now(),
  updated_by_email text not null
);

create table weather_forecast_cache (
  farm_id bigint primary key references farms(id),
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  fetched_at timestamptz not null,
  choices text[] not null,
  hours jsonb not null
);
`,
  };
