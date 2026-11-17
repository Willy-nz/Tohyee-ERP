import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0258",
    name: "metservice_forecast_records",
    sql: `
-- Keeping forecast records, only for an organisation that says it has
-- MetService's written permission (decisions 1547-1549; WX8-WX10). Off by
-- default. The permission's date and reference are kept, with who turned it
-- on and when (and in the audit log), and optionally the permission itself
-- as a file. Combining the records with the farm's own data (forecast vs
-- rain gauge, Analytics, the AI) is a second switch that needs the first.
-- Turning records off deletes them unless the admin chooses to keep them.
alter table weather_settings
  add column keep_records boolean not null default false,
  add column permission_granted_on date,
  add column permission_reference text,
  add column keep_records_set_at timestamptz,
  add column keep_records_set_by_email text,
  add column combine boolean not null default false,
  add column combine_set_at timestamptz,
  add column combine_set_by_email text,
  add constraint weather_settings_combine_needs_records check (not combine or keep_records),
  add constraint weather_settings_permission_details check (not keep_records or (permission_granted_on is not null and permission_reference is not null));

create table weather_permission_files (
  id boolean primary key default true check (id),
  file_name text not null,
  content_type text not null,
  byte_size integer not null,
  sha256 text not null,
  content bytea not null,
  added_at timestamptz not null default now(),
  added_by_email text not null
);

create table weather_forecast_history (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  fetched_at timestamptz not null,
  choices text[] not null,
  hours jsonb not null
);
create index weather_forecast_history_farm on weather_forecast_history (farm_id, fetched_at);
`,
  };
