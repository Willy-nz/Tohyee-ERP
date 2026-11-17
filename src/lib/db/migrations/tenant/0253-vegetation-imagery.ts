import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0253",
    name: "vegetation_imagery",
    sql: `
-- Satellite vegetation (#612, decisions 1520-1540). Optional, free-source
-- Sentinel-2 pictures of a farm's paddocks, worked into a greenness index
-- (NDVI) a paddock. Pictures live on the server's data disk
-- (TOHYEE_VEGETATION_DIR), never in the database; these tables hold the
-- settings, what was asked for, where it came from and the numbers.

-- One row: the organisation's connection and limits. The provider's secret is
-- encrypted with the server's key (a _ciphertext column, so a restore re-keys
-- it, decision 737) and never leaves the server.
create table vegetation_settings (
  id boolean primary key default true check (id),
  provider text check (provider in ('copernicus', 'demo')),
  client_id text check (client_id is null or length(client_id) between 1 and 200),
  client_secret_ciphertext text,
  connected_by_email text,
  connected_at timestamptz,
  connection_status text not null default 'none' check (connection_status in ('none', 'ok', 'reconnect')),
  connection_error text,
  enabled boolean not null default false,
  monthly_unit_budget numeric(10,2) not null default 2000 check (monthly_unit_budget > 0 and monthly_unit_budget <= 100000),
  monthly_request_budget integer not null default 1000 check (monthly_request_budget between 1 and 100000),
  storage_cap_bytes bigint not null default 524288000 check (storage_cap_bytes between 10485760 and 1099511627776),
  min_coverage_pct integer not null default 80 check (min_coverage_pct between 50 and 100),
  min_valid_pixels integer not null default 20 check (min_valid_pixels between 5 and 10000),
  history_days integer not null default 60 check (history_days between 7 and 365),
  retention_days integer not null default 120 check (retention_days between 14 and 3650),
  paused_reason text check (paused_reason in ('quota', 'requests', 'storage', 'disk_full')),
  paused_at timestamptz,
  last_test jsonb,
  updated_by_email text,
  updated_at timestamptz
);

-- Which farms get pictures, and the boundary versions confirmed as the
-- area sent to the provider.
create table vegetation_farms (
  farm_id bigint primary key references farms(id),
  enabled boolean not null default false,
  confirmed_boundary_ids bigint[] not null default '{}',
  confirmed_by_email text,
  confirmed_at timestamptz,
  next_check_at timestamptz,
  last_checked_at timestamptz,
  last_check_error text,
  updated_by_email text,
  updated_at timestamptz
);

-- One satellite date for one farm, with where it came from. Acquisition
-- time is the satellite's; retrieved_at is only when Tohyee fetched it.
create table vegetation_scenes (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  provider text not null check (provider in ('copernicus', 'demo')),
  acquired_at timestamptz not null,
  retrieved_at timestamptz not null,
  product_ids text[] not null,
  processing_baseline text,
  platform text,
  scene_cloud_pct numeric(5,2),
  processor_version text not null,
  dn_offset integer not null default 0,
  licence text not null,
  grid jsonb not null,
  farm_valid_pct numeric(5,2),
  usable boolean not null,
  paddocks_good integer not null default 0,
  units_spent numeric(10,4),
  units_estimated numeric(10,4) not null default 0,
  raw_path text,
  overlay_path text,
  change_path text,
  change_from_scene_id bigint references vegetation_scenes(id),
  bytes bigint not null default 0,
  sha256 text,
  files_removed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (farm_id, acquired_at, processor_version)
);
create index vegetation_scenes_farm on vegetation_scenes (farm_id, acquired_at desc);

-- A paddock's numbers on one date, tied to the boundary version used.
-- Missing is null, never zero.
create table vegetation_observations (
  id bigserial primary key,
  scene_id bigint not null references vegetation_scenes(id),
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  boundary_id bigint not null references paddock_boundaries(id),
  processor_version text not null,
  acquired_at timestamptz not null,
  total_pixels integer not null check (total_pixels >= 0),
  valid_pixels integer not null check (valid_pixels >= 0 and valid_pixels <= total_pixels),
  edge_pixels integer not null check (edge_pixels >= 0 and edge_pixels <= total_pixels),
  coverage_pct numeric(5,2),
  mean_ndvi numeric(5,4) check (mean_ndvi between -1 and 1),
  median_ndvi numeric(5,4) check (median_ndvi between -1 and 1),
  quality text not null check (quality in ('good', 'low_coverage', 'too_small', 'no_data')),
  flags text[] not null default '{}',
  change_ndvi numeric(5,4) check (change_ndvi between -2 and 2),
  change_from_scene_id bigint references vegetation_scenes(id),
  change_pixels integer,
  created_at timestamptz not null default now(),
  check ((valid_pixels = 0) = (mean_ndvi is null)),
  unique (scene_id, paddock_id, boundary_id)
);
create index vegetation_observations_paddock on vegetation_observations (paddock_id, acquired_at desc);
create index vegetation_observations_farm on vegetation_observations (farm_id, acquired_at desc);
create trigger vegetation_observations_no_delete before delete on vegetation_observations for each row execute function toeyee_forbid_delete();

-- The low-priority worker's jobs. The key makes asking twice one job; the
-- checkpoint lets a restart carry on without fetching again.
create table vegetation_jobs (
  id bigserial primary key,
  farm_id bigint references farms(id),
  kind text not null check (kind in ('discover', 'fetch', 'reprocess', 'test')),
  job_key text not null unique,
  payload jsonb not null default '{}',
  checkpoint jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  units_spent numeric(10,4) not null default 0,
  requests integer not null default 0,
  bytes_fetched bigint not null default 0,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index vegetation_jobs_due on vegetation_jobs (next_attempt_at, id) where status in ('queued', 'running');
create index vegetation_jobs_month on vegetation_jobs (created_at);
`,
  };
