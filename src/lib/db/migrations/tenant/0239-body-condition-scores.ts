import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0239",
    name: "body_condition_scores",
    sql: `
-- Body condition scores (decisions 1487-1490). A score is for one animal,
-- or for a mob as an average with, if counted, how many at each score. The
-- scale is kept on each record, so changing a farm's scale never changes
-- old scores.
create table bcs_scale_settings (
  farm_id bigint not null references farms(id),
  kind text not null,
  scale text not null check (scale in ('1_10', '1_5')),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (farm_id, kind)
);

create table bcs_records (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  animal_id bigint references animals(id),
  mob_id bigint references mobs(id),
  scored_on date not null,
  scale text not null check (scale in ('1_10', '1_5')),
  -- An animal's score, or a mob's average.
  score numeric(3, 1) not null check (score >= 1 and score <= 10),
  head_scored integer check (head_scored is null or head_scored between 1 and 100000),
  -- A mob's tally: {"4.5": 12, "5.0": 30}.
  tally jsonb,
  scored_by text check (scored_by is null or length(scored_by) between 1 and 100),
  source text not null default 'typed' check (source in ('typed', 'quick', 'import', 'ai_suggestion')),
  note text check (note is null or length(note) <= 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((animal_id is null) <> (mob_id is null)),
  check (animal_id is null or (tally is null and head_scored is null)),
  check ((status = 'removed') = (removed_reason is not null))
);
create index bcs_records_animal on bcs_records (animal_id, scored_on) where animal_id is not null;
create index bcs_records_mob on bcs_records (mob_id, scored_on) where mob_id is not null;
create index bcs_records_farm on bcs_records (farm_id, scored_on);
create unique index bcs_records_operation_id_key on bcs_records (operation_id) where operation_id is not null;
create trigger bcs_records_no_delete before delete on bcs_records for each row execute function toeyee_forbid_delete();

-- Photos of an animal or a mob for condition scoring, kept in the farm's
-- photo store (safety_files). With a record, or waiting to be scored.
create table bcs_photos (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  -- The photo in safety_files (checked when added; no foreign key, so safety_files stays append-only and its truncate guard answers first).
  file_id uuid not null unique,
  animal_id bigint references animals(id),
  mob_id bigint references mobs(id),
  taken_on date not null,
  bcs_record_id bigint references bcs_records(id),
  status text not null default 'active' check (status in ('active', 'removed')),
  operation_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((animal_id is null) <> (mob_id is null))
);
create index bcs_photos_animal on bcs_photos (animal_id, taken_on) where animal_id is not null;
create index bcs_photos_mob on bcs_photos (mob_id, taken_on) where mob_id is not null;
create unique index bcs_photos_operation_id_key on bcs_photos (operation_id) where operation_id is not null;
create trigger bcs_photos_no_delete before delete on bcs_photos for each row execute function toeyee_forbid_delete();
`,
  };
