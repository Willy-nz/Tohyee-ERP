import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0305",
    name: "saved_searches",
    sql: `
-- A saved search: a kind of record with filters, columns and a sort, kept
-- under a name. It holds no figures of its own; it reads the live books each
-- time it's opened. Private to the person who made it unless shared.
create table saved_searches (
  id bigserial primary key,
  record_type text not null check (length(record_type) between 1 and 40),
  name text not null check (length(btrim(name)) between 1 and 80),
  -- { filters: [{ field, op, value?, value2? }], columns: [field], sort: { field, direction } | null }, checked against the field catalogue when saved and again when run.
  definition jsonb not null,
  shared boolean not null default false,
  owner_user_id uuid,
  owner_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text not null
);
create index saved_searches_owner on saved_searches (owner_user_id);
`,
  };
