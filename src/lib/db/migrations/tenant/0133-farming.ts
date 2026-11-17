import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0133",
    name: "farming",
    sql: `
-- Tohyee Farming, stage 1 (#249, decision 514): farms and paddocks. A
-- paddock's identity doesn't depend on its name. Its boundary is versioned
-- GeoJSON (no PostGIS); a split or merge retires paddocks and links the new
-- ones to them, so history keeps its own areas (FB7). Nothing here posts.
create table farming_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into farming_settings (id) values (true);

create table farms (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  notes text check (notes is null or length(notes) <= 1000),
  is_active boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create unique index farms_name on farms (lower(name));

create table paddocks (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  name text not null check (length(name) between 1 and 60),
  -- The farmer's effective area: what plans use (FB1).
  effective_ha numeric check (effective_ha is null or (effective_ha > 0 and scale(effective_ha) <= 2)),
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_on date,
  created_on date not null,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((status = 'retired') = (retired_on is not null))
);
-- Names are unique among a farm's current paddocks; a retired "14" can coexist with a new "14".
create unique index paddocks_active_name on paddocks (farm_id, lower(name)) where status = 'active';

-- Each version of a paddock's boundary. The newest is current; earlier ones are kept.
create table paddock_boundaries (
  id bigserial primary key,
  paddock_id bigint not null references paddocks(id),
  geometry jsonb not null,
  mapped_ha numeric not null check (mapped_ha > 0),
  source text not null check (length(source) between 1 and 200),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index paddock_boundaries_paddock on paddock_boundaries (paddock_id, id);

-- Splits and merges (FB7): which paddocks a paddock came from.
create table paddock_lineage (
  paddock_id bigint not null references paddocks(id),
  from_paddock_id bigint not null references paddocks(id),
  kind text not null check (kind in ('split', 'merge')),
  on_date date not null,
  primary key (paddock_id, from_paddock_id),
  check (paddock_id <> from_paddock_id)
);

-- Files imported, so the same file isn't imported twice.
create table farm_imports (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  kind text not null check (kind in ('paddock_boundaries')),
  file_name text not null,
  sha256 text not null,
  summary jsonb not null,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (farm_id, kind, sha256)
);

create trigger farms_no_delete before delete on farms for each row execute function toeyee_forbid_delete();
create trigger paddocks_no_delete before delete on paddocks for each row execute function toeyee_forbid_delete();
create trigger paddock_boundaries_no_delete before delete or update on paddock_boundaries for each row execute function toeyee_forbid_delete();
`,
  };
