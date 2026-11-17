import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0282",
    name: "annual_statement_drafts",
    sql: `
-- More than one set of the annual financial statements' words for a year end
-- (FS16-FS19, decision 1631): each set has a title and its own cover,
-- compilation report, page headings and, once saved, notes. Drafts show
-- under Reports > Drafts; at most one set a year is final. The figures are
-- always live. Sets saved before are copied in; annual_statement_documents
-- is no longer read.
create table annual_statement_drafts (
  id bigserial primary key,
  year_end date not null,
  title text not null check (length(title) between 1 and 200),
  status text not null check (status in ('draft', 'final')),
  texts jsonb not null,
  notes jsonb,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create unique index annual_statement_drafts_one_final on annual_statement_drafts (year_end) where status = 'final';
create index annual_statement_drafts_list on annual_statement_drafts (status, updated_at desc);
insert into annual_statement_drafts (year_end, title, status, texts, created_by_email, created_at, updated_by_email, updated_at)
select year_end, 'Financial statements ' || to_char(year_end, 'YYYY'), status, texts, updated_by_email, updated_at, updated_by_email, updated_at
  from annual_statement_documents;
`,
  };
