import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0143",
    name: "financial_statement_notes",
    sql: `
-- Notes to the year-end financial statements (#259, examples FS1-FS3): the
-- organisation's own policy notes, in order, edited in Tohyee and printed
-- after the statements. Drafts are offered until the organisation saves its
-- own; nothing here posts.
create table financial_statement_notes (
  id bigserial primary key,
  position integer not null check (position between 1 and 100),
  title text not null check (length(title) between 1 and 150),
  body text not null check (length(body) between 1 and 10000),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create unique index financial_statement_notes_position on financial_statement_notes (position);
`,
  };
