import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0197",
    name: "tractor_mode",
    sql: `
-- Tractor and spreader mode (#472 stage 5, decisions 1020-1027). A job is a
-- phone's GPS track while someone spread, sprayed or mowed, with the area it
-- probably covered worked out from it. Nothing here posts to the books.

-- A spreader, sprayer or mower as tractor mode knows it: optionally the
-- machine in Safety's equipment register (a safety record id) and the fixed
-- asset in the books.
create table tractor_equipment (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  kind text not null check (kind in ('spreader', 'sprayer', 'mower', 'other')),
  safety_equipment_id uuid,
  fixed_asset_id bigint references fixed_assets(id),
  is_active boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz
);
create unique index tractor_equipment_name on tractor_equipment (lower(name)) where is_active;
create trigger tractor_equipment_no_delete before delete on tractor_equipment for each row execute function toeyee_forbid_delete();

-- Its working width and offsets. Each change is a new row with its time;
-- the newest is current. A job keeps the settings it was driven with, so
-- changing them never changes an old job.
create table tractor_equipment_settings (
  id bigserial primary key,
  equipment_id bigint not null references tractor_equipment(id),
  width_m numeric not null check (width_m > 0 and width_m <= 60 and scale(width_m) <= 2),
  lateral_offset_m numeric not null default 0 check (lateral_offset_m between -30 and 30 and scale(lateral_offset_m) <= 2),
  back_offset_m numeric not null default 0 check (back_offset_m between -30 and 30 and scale(back_offset_m) <= 2),
  note text check (note is null or length(note) <= 500),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index tractor_equipment_settings_equipment on tractor_equipment_settings (equipment_id, id desc);
create trigger tractor_equipment_settings_append_only before update or delete on tractor_equipment_settings
  for each row execute function toeyee_forbid_mutation();
create trigger tractor_equipment_settings_no_truncate before truncate on tractor_equipment_settings
  for each statement execute function toeyee_forbid_mutation();

-- A job. Its id is made by the phone, so sending it again finds the same
-- job instead of adding another. The track (every fix, with its time,
-- accuracy, Working ON or OFF and settings) and who drove never change;
-- the paddocks, links and notes can, and the summary is worked out again
-- from the same track when the paddocks change. Declared product, rate and
-- quantity are what someone typed, never measured.
create table tractor_jobs (
  id uuid primary key,
  farm_id bigint not null references farms(id),
  paddock_ids bigint[] not null default '{}',
  -- The boundary versions the summary was clipped to.
  boundary_ids bigint[] not null default '{}',
  operation text not null check (operation in ('spreading', 'spraying', 'mowing', 'other')),
  equipment_id bigint references tractor_equipment(id),
  operator_user_id uuid not null,
  operator_email text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null check (finished_at >= started_at),
  point_count integer not null check (point_count between 0 and 100000),
  track jsonb not null check (jsonb_typeof(track) = 'object'),
  track_sha256 text not null check (track_sha256 ~ '^[0-9a-f]{64}$'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  coverage jsonb not null check (jsonb_typeof(coverage) = 'object'),
  worked_ha numeric not null check (worked_ha >= 0),
  notes text check (notes is null or length(notes) <= 2000),
  fertiliser_plan_id bigint references fertiliser_plans(id),
  fertiliser_application_id bigint references fertiliser_applications(id),
  chemical_record_id uuid,
  product text check (product is null or length(product) <= 150),
  declared_rate numeric check (declared_rate is null or (declared_rate > 0 and scale(declared_rate) <= 3)),
  declared_rate_unit text check (declared_rate_unit is null or declared_rate_unit in ('kg/ha', 'L/ha', 't/ha')),
  declared_quantity numeric check (declared_quantity is null or (declared_quantity > 0 and scale(declared_quantity) <= 3)),
  declared_quantity_unit text check (declared_quantity_unit is null or declared_quantity_unit in ('kg', 'L', 't')),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) <= 1000),
  received_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz,
  check ((status = 'withdrawn') = (withdrawn_reason is not null)),
  check ((declared_rate is null) = (declared_rate_unit is null)),
  check ((declared_quantity is null) = (declared_quantity_unit is null))
);
create index tractor_jobs_farm on tractor_jobs (farm_id, started_at desc);
create index tractor_jobs_operator on tractor_jobs (operator_user_id, started_at desc);

create function tohyee_guard_tractor_job() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Tractor jobs can''t be deleted; withdraw them instead' using errcode = 'P0001';
  end if;
  if new.track is distinct from old.track or new.track_sha256 <> old.track_sha256 or new.farm_id <> old.farm_id
     or new.operator_user_id <> old.operator_user_id or new.operator_email <> old.operator_email
     or new.started_at <> old.started_at or new.finished_at <> old.finished_at or new.received_at <> old.received_at then
    raise exception 'A tractor job''s track, farm, operator and times can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tractor_jobs_guard before update or delete on tractor_jobs for each row execute function tohyee_guard_tractor_job();
create trigger tractor_jobs_no_truncate before truncate on tractor_jobs for each statement execute function toeyee_forbid_delete();
`,
  };
