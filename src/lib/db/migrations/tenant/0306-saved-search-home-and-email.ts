import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0306",
    name: "saved_search_home_and_email",
    sql: `
-- A saved search can be shown on Home (its own on its maker's Home; a shared
-- one on everyone's), and anyone who can open it can have it emailed to them.
alter table saved_searches add column on_home boolean not null default false;

create table saved_search_emails (
  id bigserial primary key,
  search_id bigint not null references saved_searches(id) on delete cascade,
  user_id uuid not null,
  email text not null,
  -- daily; weekly: the first check of a new week (Monday on); monthly: the first check of a new month.
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  -- always; has_rows: only when something matches; new_rows: only when something matches that wasn't there last time.
  only_when text not null default 'always' check (only_when in ('always', 'has_rows', 'new_rows')),
  last_checked_on date,
  last_sent_on date,
  -- The ids that matched at the last check, for new_rows.
  seen_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (search_id, user_id)
);
`,
  };
