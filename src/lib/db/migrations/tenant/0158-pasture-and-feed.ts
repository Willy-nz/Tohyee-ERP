import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0158",
    name: "pasture_and_feed",
    sql: `
-- Pasture and feed records (#249 stage 4; examples PF1-PF8, decision 559).
-- Records only: nothing posts. Removed records are kept for the history.
create table pasture_readings (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  measured_on date not null,
  cover integer not null check (cover between 0 and 20000),
  method text not null check (method in ('plate_meter', 'visual', 'measured_other', 'satellite', 'model')),
  note text check (note is null or length(note) between 1 and 200),
  source text not null check (length(source) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index pasture_readings_paddock on pasture_readings (paddock_id, measured_on) where status = 'active';

create table grazings (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  mob text not null check (length(mob) between 1 and 100),
  head integer check (head is null or head between 1 and 100000),
  in_on date not null,
  out_on date check (out_on is null or out_on >= in_on),
  pre_cover integer check (pre_cover is null or pre_cover between 0 and 20000),
  post_cover integer check (post_cover is null or post_cover between 0 and 20000),
  note text check (note is null or length(note) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create unique index grazings_one_open on grazings (paddock_id) where status = 'active' and out_on is null;

create table supplements_fed (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  paddock_id bigint references paddocks(id),
  fed_on date not null,
  feed text not null check (length(feed) between 1 and 100),
  quantity numeric(18, 2) not null check (quantity > 0),
  unit text not null check (unit in ('kg_dm', 'kg_as_fed', 't_as_fed', 'bales', 'other')),
  kg_dm numeric(18, 2) check (kg_dm is null or kg_dm >= 0),
  mob text check (mob is null or length(mob) between 1 and 100),
  note text check (note is null or length(note) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);

create trigger pasture_readings_no_delete before delete on pasture_readings for each row execute function toeyee_forbid_delete();
create trigger grazings_no_delete before delete on grazings for each row execute function toeyee_forbid_delete();
create trigger supplements_fed_no_delete before delete on supplements_fed for each row execute function toeyee_forbid_delete();

alter table farm_imports drop constraint farm_imports_kind_check;
alter table farm_imports add constraint farm_imports_kind_check check (kind in ('paddock_boundaries', 'fertiliser_applications', 'soil_tests', 'pasture_readings'));
`,
  };
