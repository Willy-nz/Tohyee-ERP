import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0191",
    name: "farm_safety_weekly_copy",
    sql: `
-- A copy of the farm safety records emailed off the farm each week (#446,
-- decisions 958-959): a PDF of what was entered that week, and the number
-- and hash of the latest entry in the whole history. Kept somewhere Tohyee
-- can't reach, it shows later whether the history was rewritten. Only an
-- email the mail server accepted is recorded as sent; a failure is kept as
-- the last problem, never as a copy.
create table safety_copy_settings (
  id boolean primary key default true check (id),
  is_on boolean not null default false,
  to_addresses text[] not null default '{}' check (cardinality(to_addresses) <= 10),
  last_attempt_at timestamptz,
  last_problem text check (last_problem is null or length(last_problem) <= 1000),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create table safety_copies (
  id bigserial primary key,
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  head_seq bigint,
  head_hash text check (head_hash is null or head_hash ~ '^[0-9a-f]{64}$'),
  entries integer not null check (entries >= 0),
  to_addresses text[] not null,
  message_id text,
  sent_by_email text not null,
  sent_at timestamptz not null default now()
);
create trigger safety_copies_append_only before update or delete on safety_copies
  for each row execute function toeyee_forbid_mutation();
create trigger safety_copies_no_truncate before truncate on safety_copies
  for each statement execute function toeyee_forbid_mutation();
`,
  };
