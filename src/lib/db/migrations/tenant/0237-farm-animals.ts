import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0237",
    name: "farm_animals",
    sql: `
-- The animal register (decisions 1481-1485; examples AN1-AN8, common NZ
-- practice, not yet reviewed). An animal is on a farm, with a kind, a
-- visual tag and optionally an EID or NAIT number (just a field). It's in
-- at most one mob at a time, and its mob history is kept. Tagging an animal
-- into a mob never changes the mob's head or the books' livestock
-- movements: sales and deaths of tagged animals go through the mob.
create table animals (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  kind text not null,
  tag text not null check (length(tag) between 1 and 30),
  eid text check (eid is null or length(eid) between 1 and 30),
  sex text check (sex is null or sex in ('female', 'male', 'castrated')),
  breed text check (breed is null or length(breed) between 1 and 60),
  birth_on date,
  dam_id bigint references animals(id),
  dam_text text check (dam_text is null or length(dam_text) between 1 and 60),
  sire_id bigint references animals(id),
  sire_text text check (sire_text is null or length(sire_text) between 1 and 60),
  status text not null default 'on_farm' check (status in ('on_farm', 'sold', 'dead', 'missing')),
  status_on date,
  -- The mob's sale or death that this animal was part of.
  status_event_id bigint references mob_events(id),
  note text check (note is null or length(note) <= 500),
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (status in ('on_farm', 'missing') or (status_on is not null and status_event_id is not null)),
  check (dam_id is null or dam_id <> id),
  check (sire_id is null or sire_id <> id)
);
create unique index animals_tag_on_farm on animals (farm_id, kind, lower(tag)) where status in ('on_farm', 'missing');
create unique index animals_eid_on_farm on animals (farm_id, lower(eid)) where eid is not null and status in ('on_farm', 'missing');
create unique index animals_operation_id_key on animals (operation_id) where operation_id is not null;
create index animals_farm on animals (farm_id, status);
create trigger animals_no_delete before delete on animals for each row execute function toeyee_forbid_delete();

-- Which mob an animal was in, and when. One open row per animal at most.
create table animal_mobs (
  id bigserial primary key,
  animal_id bigint not null references animals(id),
  mob_id bigint not null references mobs(id),
  from_on date not null,
  to_on date check (to_on is null or to_on >= from_on),
  how_in text not null check (how_in in ('tagged', 'moved', 'split', 'merged')),
  how_out text check (how_out is null or how_out in ('moved', 'split', 'merged', 'sold', 'died', 'corrected')),
  in_event_id bigint references mob_events(id),
  out_event_id bigint references mob_events(id),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((to_on is null) = (how_out is null))
);
create unique index animal_mobs_current on animal_mobs (animal_id) where to_on is null;
create index animal_mobs_mob on animal_mobs (mob_id, from_on);
create trigger animal_mobs_no_delete before delete on animal_mobs for each row execute function toeyee_forbid_delete();

-- Tagged animals moved from one mob to another of the same class: the head
-- goes with them, and no livestock movement is made (decision 1483).
alter table mob_events drop constraint mob_events_event_type_check;
alter table mob_events add constraint mob_events_event_type_check check (event_type in (
  'created', 'moved', 'split_out', 'split_in', 'merged_out', 'merged_in',
  'sold', 'died', 'born', 'bought', 'reclass', 'weighed', 'counted', 'closed', 'animals_out', 'animals_in'));

alter table farm_imports drop constraint farm_imports_kind_check;
alter table farm_imports add constraint farm_imports_kind_check check (kind in ('paddock_boundaries', 'fertiliser_applications', 'soil_tests', 'pasture_readings', 'mobs', 'grazings', 'animals', 'animal_records'));
`,
  };
