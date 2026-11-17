import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0004",
    name: "server_starts_and_update_backups",
    sql: `
-- The backups the server app makes just before installing an update
-- (decision 329) are marked as such.
alter table backup_runs drop constraint backup_runs_trigger_check;
alter table backup_runs add constraint backup_runs_trigger_check check (trigger in ('schedule', 'manual', 'update'));

-- Each time the server starts: its version, the version that ran before it,
-- and what the start-up database upgrades did (decision 330). Written by the
-- server as it starts, never typed in by a person. After an update, this is
-- how the server app knows the new version is running and which
-- organisations, if any, couldn't be upgraded and are blocked.
create table server_starts (
  id bigserial primary key,
  version text not null,
  previous_version text,
  started_at timestamptz not null default now(),
  core_applied text[] not null default '{}',
  organisations_checked integer not null,
  organisations_upgraded integer not null,
  -- [{ "organisationId": "...", "error": "..." }]
  organisations_blocked jsonb not null default '[]'::jsonb
);
create index server_starts_started_at_idx on server_starts (started_at desc);
create trigger server_starts_append_only before update or delete on server_starts
  for each row execute function toeyee_forbid_mutation();
`,
  };
