import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0234",
    name: "farm_treatments",
    sql: `
-- Animal treatments, paddock withholding after spraying and product stock
-- (decisions 1431-1438). Withholding periods are what the person typed from
-- the product's label; Tohyee never supplies one. Records only: nothing
-- posts to the books.
create table animal_treatments (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  mob_id bigint references mobs(id),
  -- Animals treated by tag or description, when it isn't (all of) a mob.
  animals text check (animals is null or length(animals) between 1 and 500),
  head integer not null check (head between 1 and 100000),
  treated_on date not null,
  -- The time it was given, in the farm's local time, when known: milk withholding then counts from it exactly.
  given_time time,
  product text not null check (length(product) between 1 and 150),
  -- The product in Safety's chemical register, when it's there (its stock is then reduced).
  chemical_record_id uuid,
  batch text check (batch is null or length(batch) between 1 and 60),
  dose text not null check (length(dose) between 1 and 100),
  quantity numeric(18, 3) check (quantity is null or quantity > 0),
  quantity_unit text check (quantity_unit is null or length(quantity_unit) between 1 and 20),
  meat_withholding_days integer check (meat_withholding_days is null or meat_withholding_days between 0 and 1000),
  milk_withholding_hours integer check (milk_withholding_hours is null or milk_withholding_hours between 0 and 24000),
  reason text check (reason is null or length(reason) between 1 and 200),
  given_by text not null check (length(given_by) between 1 and 100),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  operation_id uuid,
  request_hash text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (mob_id is not null or animals is not null),
  check ((quantity is null) = (quantity_unit is null)),
  check ((status = 'removed') = (removed_reason is not null))
);
create index animal_treatments_farm on animal_treatments (farm_id, treated_on desc, id desc);
create index animal_treatments_mob on animal_treatments (mob_id, treated_on desc) where mob_id is not null;
create unique index animal_treatments_operation_id_key on animal_treatments (operation_id) where operation_id is not null;
create trigger animal_treatments_no_delete before delete on animal_treatments for each row execute function toeyee_forbid_delete();

-- A spray job's grazing withholding, from the label, for the job's paddocks.
create table paddock_withholdings (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  tractor_job_id uuid not null references tractor_jobs(id),
  -- The day the spraying finished (New Zealand date); withholding runs from it.
  from_on date not null,
  days integer not null check (days between 0 and 365),
  note text check (note is null or length(note) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create unique index paddock_withholdings_job on paddock_withholdings (tractor_job_id) where status = 'active';
create trigger paddock_withholdings_no_delete before delete on paddock_withholdings for each row execute function toeyee_forbid_delete();

-- Product stock received, counted or thrown out, for chemicals in Safety's
-- register. Use by treatments and spray jobs is worked out from them.
create table farm_product_stock (
  id bigserial primary key,
  chemical_record_id uuid not null,
  farm_id bigint references farms(id),
  movement_type text not null check (movement_type in ('received', 'counted', 'disposed')),
  moved_on date not null,
  -- Received and disposed: the amount (positive). Counted: what was there.
  quantity numeric(18, 3) not null check (quantity >= 0),
  unit text not null check (length(unit) between 1 and 20),
  batch text check (batch is null or length(batch) between 1 and 60),
  expires_on date,
  note text check (note is null or length(note) between 1 and 200),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index farm_product_stock_chemical on farm_product_stock (chemical_record_id, moved_on, id);
create trigger farm_product_stock_append_only before update or delete on farm_product_stock for each row execute function toeyee_forbid_mutation();
create trigger farm_product_stock_no_truncate before truncate on farm_product_stock for each statement execute function toeyee_forbid_mutation();
`,
  };
