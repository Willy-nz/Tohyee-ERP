import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0233",
    name: "farm_mobs",
    sql: `
-- Mobs (decisions 1421-1430; examples MOB1-MOB10, common NZ practice, not
-- yet reviewed). A mob is a group of one IRD class on a farm. Where it is
-- comes from its open grazing, so a move is a grazing out and in. Head
-- changes that matter for tax (sold, died, born, bought, class change) are
-- livestock_movements, linked from the mob's event, never a second count.
create table mobs (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  name text check (name is null or length(name) between 1 and 100),
  kind text not null,
  class_code text not null check (length(class_code) between 1 and 50),
  head integer not null check (head between 0 and 100000),
  tag_colour text check (tag_colour is null or length(tag_colour) between 1 and 30),
  status text not null default 'active' check (status in ('active', 'closed')),
  closed_on date,
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((status = 'closed') = (closed_on is not null)),
  check (status = 'active' or head = 0)
);
create unique index mobs_active_name on mobs (farm_id, lower(name)) where status = 'active' and name is not null;
create unique index mobs_operation_id_key on mobs (operation_id) where operation_id is not null;
create index mobs_farm on mobs (farm_id, status);
create trigger mobs_no_delete before delete on mobs for each row execute function toeyee_forbid_delete();

-- A grazing can be a mob's: several mobs may share a paddock, but a mob is
-- in one paddock at a time. A grazing typed with only a mob name keeps the
-- old rule: nothing else is in the paddock with it (checked by the app).
alter table grazings add column mob_id bigint references mobs(id);
drop index grazings_one_open;
create unique index grazings_one_open on grazings (paddock_id) where status = 'active' and out_on is null and mob_id is null;
create unique index grazings_mob_open on grazings (mob_id) where status = 'active' and out_on is null and mob_id is not null;
create index grazings_mob on grazings (mob_id, in_on) where mob_id is not null;

-- Everything that happened to a mob, append-only. head_after is the mob's
-- head once this event is applied.
create table mob_events (
  id bigserial primary key,
  mob_id bigint not null references mobs(id),
  farm_id bigint not null references farms(id),
  event_type text not null check (event_type in (
    'created', 'moved', 'split_out', 'split_in', 'merged_out', 'merged_in',
    'sold', 'died', 'born', 'bought', 'reclass', 'weighed', 'counted', 'closed')),
  event_date date not null,
  head_change integer not null default 0,
  head_after integer not null check (head_after >= 0),
  -- How a new mob came: already on the farm, bought or born.
  created_how text check (created_how is null or created_how in ('on_farm', 'bought', 'born', 'split', 'grazing', 'import')),
  from_class_code text,
  to_class_code text,
  other_mob_id bigint references mobs(id),
  from_paddock_id bigint references paddocks(id),
  to_paddock_id bigint references paddocks(id),
  grazing_id bigint references grazings(id),
  livestock_movement_id bigint references livestock_movements(id),
  amount numeric(18, 2) check (amount is null or amount >= 0),
  average_kg numeric(8, 1) check (average_kg is null or (average_kg > 0 and average_kg <= 2000)),
  weighed_head integer check (weighed_head is null or weighed_head > 0),
  note text check (note is null or length(note) <= 500),
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((event_type = 'weighed') = (average_kg is not null)),
  check ((event_type = 'reclass') = (to_class_code is not null))
);
create index mob_events_mob on mob_events (mob_id, event_date desc, id desc);
create index mob_events_farm on mob_events (farm_id, event_date desc, id desc);
create unique index mob_events_operation_id_key on mob_events (operation_id) where operation_id is not null;
-- A livestock movement is one mob event's at most: a head count is never counted twice.
create unique index mob_events_movement on mob_events (livestock_movement_id) where livestock_movement_id is not null;
create trigger mob_events_append_only before update or delete on mob_events for each row execute function toeyee_forbid_mutation();
create trigger mob_events_no_truncate before truncate on mob_events for each statement execute function toeyee_forbid_mutation();

-- Stock unit factors this organisation changed; the rest are Tohyee's
-- defaults (src/lib/farming/stock-units.ts), with their source.
create table stock_unit_factors (
  kind text not null,
  class_code text not null,
  factor numeric(5, 2) not null check (factor > 0 and factor <= 50),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (kind, class_code)
);

alter table farm_imports drop constraint farm_imports_kind_check;
alter table farm_imports add constraint farm_imports_kind_check check (kind in ('paddock_boundaries', 'fertiliser_applications', 'soil_tests', 'pasture_readings', 'mobs'));
`,
  };
