import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0154",
    name: "ird_documents",
    sql: `
-- IRD documents and figures the connected AI proposes from them (examples
-- ITX30-ITX35, decision 549). Proposals change nothing until a person
-- accepts one.
create table ird_documents (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null,
  byte_size integer not null check (byte_size > 0),
  sha256 text not null,
  content bytea,
  income_year integer check (income_year is null or income_year between 2000 and 2100),
  note text check (note is null or length(note) <= 200),
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  check ((removed_at is null) = (removed_reason is null)),
  check (removed_at is null or content is null)
);

create table ird_figure_proposals (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  document_id bigint references ird_documents(id),
  income_year integer not null check (income_year between 2000 and 2100),
  figures jsonb not null,
  note text check (note is null or length(note) <= 1000),
  ai_key_name text,
  proposed_by_email text,
  created_at timestamptz not null default now(),
  status text not null default 'waiting' check (status in ('waiting', 'accepted', 'declined')),
  decided_by_email text,
  decided_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  check ((status = 'waiting') = (decided_at is null)),
  check ((status = 'declined') = (decline_reason is not null))
);
create index ird_figure_proposals_waiting on ird_figure_proposals (income_year) where status = 'waiting';
`,
  };
