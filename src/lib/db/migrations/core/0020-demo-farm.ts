import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0020",
    name: "demo_farm",
    sql: `
-- The demo farm (#437, decisions 855-869): a made-up organisation a person
-- adds for themselves, like Xero's demo company. One each; it goes when they
-- do. While it's being made (a background job) it isn't in their list yet,
-- and the build's progress is kept here so the page can show it. To take the
-- demo farm out later, a migration drops these columns (docs/DEMO-FARM.md).
alter table organisations add column demo_for_user_id uuid references users(id) on delete cascade;
alter table organisations add column demo_status text check (demo_status in ('building', 'ready', 'failed'));
alter table organisations add column demo_step text check (length(demo_step) <= 200);
alter table organisations add column demo_percent integer check (demo_percent between 0 and 100);
alter table organisations add column demo_error text check (length(demo_error) <= 2000);
alter table organisations add column demo_started_at timestamptz;
alter table organisations add column demo_updated_at timestamptz;
alter table organisations add column demo_build_ms integer;
alter table organisations add constraint organisations_demo_shape check ((demo_for_user_id is null) = (demo_status is null));
create unique index organisations_one_demo_each on organisations (demo_for_user_id) where demo_for_user_id is not null;
`,
  };
