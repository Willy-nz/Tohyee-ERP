import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0212",
    name: "security_cameras",
    sql: `
-- Farm security cameras (#508, decisions 1216-1225): cameras registered
-- per farm, each with its own upload login (password scrypt-hashed, shown
-- once), the events made from the files they upload, the farm's
-- retention, and who besides owners and admins may see them. The media
-- itself is in the camera media folder, not the database; storage_path is
-- relative to it.
create table security_cameras (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  name text not null check (length(name) between 1 and 60),
  model text check (model is null or length(model) <= 60),
  notes text check (notes is null or length(notes) <= 1000),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  latitude double precision check (latitude is null or latitude between -90 and 90),
  time_zone text not null check (length(time_zone) between 1 and 64),
  quiet_alert_hours integer not null default 24 check (quiet_alert_hours between 1 and 720),
  is_active boolean not null default true,
  upload_username text unique check (upload_username is null or upload_username ~ '^[a-z0-9][a-z0-9-]{0,31}\\.[a-z0-9]{10}$'),
  upload_password_hash text,
  upload_login_made_at timestamptz,
  upload_login_made_by_email text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((longitude is null) = (latitude is null)),
  check ((upload_username is null) = (upload_password_hash is null)),
  check (is_active or upload_username is null)
);
create unique index security_cameras_name on security_cameras (farm_id, lower(name));

create table security_farm_settings (
  farm_id bigint primary key references farms(id),
  retention_days integer not null check (retention_days between 1 and 3650),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

create table security_events (
  id bigserial primary key,
  camera_id bigint not null references security_cameras(id),
  farm_id bigint not null references farms(id),
  kind text not null check (kind in ('snapshot', 'clip')),
  -- Reolink's file names don't say what was detected (decision 1217).
  detection text not null default 'unknown' check (detection in ('unknown', 'person', 'vehicle', 'animal', 'motion')),
  file_name text not null check (length(file_name) between 1 and 255),
  -- As the camera's clock said, from the file name, and the zone it's read in (decision 1218).
  camera_local_time text check (camera_local_time is null or camera_local_time ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$'),
  camera_time_zone text not null,
  camera_at timestamptz,
  received_at timestamptz not null default now(),
  occurred_at timestamptz not null,
  clock_note text not null check (clock_note in ('ok', 'no_time', 'camera_ahead', 'arrived_late')),
  content_type text not null check (content_type in ('image/jpeg', 'video/mp4')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null check (storage_path !~ '\\.\\.'),
  has_thumbnail boolean not null default false,
  kept boolean not null default false,
  kept_note text check (kept_note is null or length(kept_note) <= 1000),
  kept_by_email text,
  kept_at timestamptz,
  check (kept or (kept_note is null and kept_by_email is null and kept_at is null)),
  check ((kind = 'snapshot') = (content_type = 'image/jpeg'))
);
-- The same file from the same camera is kept once (a resend after a dropped connection).
create unique index security_events_camera_hash on security_events (camera_id, sha256);
create index security_events_farm_time on security_events (farm_id, occurred_at desc);
create index security_events_camera_received on security_events (camera_id, received_at desc);
create index security_events_expiring on security_events (farm_id, received_at) where not kept;

-- Who besides owners and admins may see camera events, and how far (decision 1220).
create table security_camera_access (
  user_id uuid primary key,
  level text not null check (level in ('view', 'download', 'delete')),
  granted_by_email text not null,
  granted_at timestamptz not null default now()
);
`,
  };
