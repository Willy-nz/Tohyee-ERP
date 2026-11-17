import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0003",
    name: "backup_runs",
    sql: `
-- Every backup the server makes (on its schedule, or when a server admin asks),
-- one row per database: an organisation's, or the server's own (organisation_id
-- null). Written by the backup code as it works, never typed in by a person.
create table backup_runs (
  id bigserial primary key,
  organisation_id text,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  file_path text,
  size_bytes bigint,
  error text,
  requested_by_email text
);
create index backup_runs_target_idx on backup_runs (organisation_id, started_at desc);
`,
  };
