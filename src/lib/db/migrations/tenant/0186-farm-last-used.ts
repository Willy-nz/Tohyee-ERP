import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0186",
    name: "farm_last_used",
    sql: `
-- The farm each person last worked on (#447, decision 900), so a farm page
-- opens on it rather than empty, on any device. Only a convenience: access
-- is still checked on every read and record (decision 744), a farm the
-- person can no longer see is never offered, and the row goes when the
-- farm is taken off them or they leave.
create table farm_last_used (
  user_id uuid primary key,
  farm_id bigint not null references farms(id) on delete cascade,
  chosen_at timestamptz not null default now()
);
`,
  };
