import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0248",
    name: "farm_map_assets",
    sql: `
-- Farm map assets (decisions 1462-1465): troughs, gates, water points,
-- sheds, bores, tanks and the like as points, and fences, pipes, races and
-- drains as lines, with a name and a note. GeoJSON in WGS84 longitude and
-- latitude, as paddock shapes are. Removed ones are kept, with who and when.
create table farm_map_assets (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  kind text not null check (kind in ('trough', 'gate', 'water_point', 'shed', 'bore', 'tank', 'yard', 'culvert', 'other_point', 'fence', 'pipe', 'race', 'drain', 'other_line')),
  name text not null check (length(name) between 1 and 100),
  note text check (note is null or length(note) between 1 and 500),
  geometry jsonb not null check (
    (geometry->>'type' = 'Point' and kind in ('trough', 'gate', 'water_point', 'shed', 'bore', 'tank', 'yard', 'culvert', 'other_point'))
    or (geometry->>'type' = 'LineString' and kind in ('fence', 'pipe', 'race', 'drain', 'other_line') and jsonb_array_length(geometry->'coordinates') between 2 and 500)
  ),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz,
  removed_by_email text,
  removed_at timestamptz
);
create index farm_map_assets_farm on farm_map_assets (farm_id) where status = 'active';
create trigger farm_map_assets_no_delete before delete on farm_map_assets for each row execute function toeyee_forbid_delete();
`,
  };
