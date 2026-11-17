import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0016",
    name: "backup_evidence",
    sql: `
-- Backups and recovery (#389, decisions 730-739, docs/BACKUP-RECOVERY.md).
-- Each backup file's SHA-256 when it was made and checked, so a later check
-- can tell the file was changed or replaced since.
alter table backup_runs add column sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');

-- Checks done on backups after they were made: reading each database's
-- newest file back and checking it again (integrity), restoring one into a
-- scratch database that's dropped afterwards (test_restore), and restores
-- into a new organisation (restore, so one cut off by a restart can be
-- cleaned up). Written by the code doing the work, never typed in by a person.
create table backup_checks (
  id bigserial primary key,
  kind text not null check (kind in ('integrity', 'test_restore', 'restore')),
  organisation_id text,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  file_name text,
  details jsonb not null default '{}'::jsonb,
  error text,
  requested_by_email text
);
create index backup_checks_kind_idx on backup_checks (kind, started_at desc);

-- A restored copy starts with its automatic jobs (email sending, feeds,
-- mailbox checks, repeating invoices, analytics loads) paused, so it can't
-- send or import the same things as the original while both exist. A server
-- admin turns them on.
alter table organisations add column jobs_paused_at timestamptz;
alter table organisations add column jobs_paused_reason text;
`,
  };
