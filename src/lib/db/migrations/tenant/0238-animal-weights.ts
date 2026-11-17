import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0238",
    name: "animal_weights",
    sql: `
-- Weights per animal (decision 1486). A mob's weigh session can be made
-- from them: the mob's weighing names its event here.
create table animal_weights (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  animal_id bigint not null references animals(id),
  weighed_on date not null,
  kg numeric(7, 1) not null check (kg > 0 and kg <= 2000),
  mob_event_id bigint references mob_events(id),
  source text not null default 'typed' check (source in ('typed', 'quick', 'import', 'ai_suggestion')),
  note text check (note is null or length(note) <= 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((status = 'removed') = (removed_reason is not null))
);
create index animal_weights_animal on animal_weights (animal_id, weighed_on) where status = 'active';
create index animal_weights_farm on animal_weights (farm_id, weighed_on);
create unique index animal_weights_operation_id_key on animal_weights (operation_id) where operation_id is not null;
create trigger animal_weights_no_delete before delete on animal_weights for each row execute function toeyee_forbid_delete();
`,
  };
