import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0268",
    name: "ai_journal_void_settings",
    sql: `
-- How many days after posting the AI may void its own manual journals
-- (AJV5, decision 1581); null or no row: no limit.
create table ai_journal_void_settings (
  id boolean primary key default true check (id),
  max_days integer check (max_days between 1 and 3650),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
`,
  };
