import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0267",
    name: "annual_statement_documents",
    sql: `
-- The words of the annual financial statements for each year end (FS9-FS13,
-- decision 1576): cover, compilation report and page headings, saved as a
-- draft or as final. Nothing here posts.
create table annual_statement_documents (
  year_end date primary key,
  status text not null check (status in ('draft', 'final')),
  texts jsonb not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
`,
  };
