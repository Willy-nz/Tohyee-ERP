import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0247",
    name: "farm_tasks",
    sql: `
-- Farm team tasks (decisions 1457-1461): a job for someone on a farm, due
-- on a day, maybe repeating (as the farm calendar repeats), maybe at a
-- paddock or a place on the map. Each time it's done is kept with who and
-- when for the date it was due; undoing keeps that too. Nothing is deleted:
-- a task is cancelled.
create table farm_tasks (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  title text not null check (length(title) between 1 and 200),
  note text check (note is null or length(note) between 1 and 1000),
  assigned_to_user_id uuid,
  due_on date not null,
  repeat text check (repeat is null or repeat in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  paddock_id bigint references paddocks(id),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  check ((latitude is null) = (longitude is null)),
  status text not null default 'open' check (status in ('open', 'cancelled')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz
);
create index farm_tasks_farm on farm_tasks (farm_id) where status = 'open';
create index farm_tasks_assigned on farm_tasks (assigned_to_user_id) where status = 'open';

create table farm_task_done (
  id bigserial primary key,
  task_id bigint not null references farm_tasks(id),
  done_for date not null,
  done_by_email text not null,
  done_at timestamptz not null default now(),
  undone_by_email text,
  undone_at timestamptz,
  check ((undone_by_email is null) = (undone_at is null))
);
create unique index farm_task_done_once on farm_task_done (task_id, done_for) where undone_at is null;
create trigger farm_tasks_no_delete before delete on farm_tasks for each row execute function toeyee_forbid_delete();
create trigger farm_task_done_no_delete before delete on farm_task_done for each row execute function toeyee_forbid_delete();
`,
  };
