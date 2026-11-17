import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0235",
    name: "farm_breeding_rotation",
    sql: `
-- Breeding records and rotation planning (decisions 1439-1444; examples
-- BR1-BR6, common NZ practice, not yet reviewed). Records only.
create table mob_breeding (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  mob_id bigint not null references mobs(id),
  record_type text not null check (record_type in ('joining', 'ai', 'scanning', 'pregnancy_test')),
  on_date date not null,
  -- Joining: when the rams or bulls came out.
  until_on date check (until_on is null or until_on >= on_date),
  sire text check (sire is null or length(sire) between 1 and 150),
  sire_mob_id bigint references mobs(id),
  -- Joined, inseminated, scanned or tested.
  head integer not null check (head between 1 and 100000),
  technician text check (technician is null or length(technician) between 1 and 100),
  -- Scanning (sheep): how many empty, with one, two and three or more.
  empty integer check (empty is null or empty >= 0),
  singles integer check (singles is null or singles >= 0),
  twins integer check (twins is null or twins >= 0),
  triplets integer check (triplets is null or triplets >= 0),
  -- Pregnancy testing (cattle): how many in calf.
  in_calf integer check (in_calf is null or in_calf >= 0),
  note text check (note is null or length(note) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (record_type <> 'scanning' or (empty is not null and singles is not null and twins is not null and triplets is not null and empty + singles + twins + triplets = head)),
  check (record_type <> 'pregnancy_test' or (in_calf is not null and in_calf <= head)),
  check (record_type = 'joining' or until_on is null)
);
create index mob_breeding_mob on mob_breeding (mob_id, on_date desc) where status = 'active';
create unique index mob_breeding_operation_id_key on mob_breeding (operation_id) where operation_id is not null;
create trigger mob_breeding_no_delete before delete on mob_breeding for each row execute function toeyee_forbid_delete();

-- A farm's round length: the days the farmer aims for between grazings.
create table farm_rotation_settings (
  farm_id bigint primary key references farms(id),
  round_days integer not null check (round_days between 1 and 365),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- Planned moves: a mob into a paddock on a day. Done when the mob moves
-- there; cancelled ones are kept.
create table grazing_plans (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  mob_id bigint not null references mobs(id),
  paddock_id bigint not null references paddocks(id),
  planned_on date not null,
  days integer check (days is null or days between 1 and 365),
  status text not null default 'planned' check (status in ('planned', 'done', 'cancelled')),
  done_grazing_id bigint references grazings(id),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((status = 'done') = (done_grazing_id is not null))
);
create index grazing_plans_farm on grazing_plans (farm_id, planned_on) where status = 'planned';
create trigger grazing_plans_no_delete before delete on grazing_plans for each row execute function toeyee_forbid_delete();
`,
  };
