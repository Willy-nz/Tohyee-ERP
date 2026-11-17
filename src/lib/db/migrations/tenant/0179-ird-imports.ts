import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0179",
    name: "ird_imports",
    sql: `
-- IRD account files imported through a column mapping (examples
-- ITX-IMP1 to ITX-IMP12, decisions 710-716; Codex, delegated by owner, 20
-- October 2026). The file itself is kept as an IRD document (the source).
-- Each row becomes a proposed figure that a person accepts or declines;
-- accepting a payment adds (or links) an income tax payment, and allocates
-- it only when the row says which instalment it's for. Nothing posts and
-- nothing is sent to IRD.
create table ird_import_mappings (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  headings jsonb not null check (jsonb_typeof(headings) = 'array'),
  mapping jsonb not null check (jsonb_typeof(mapping) = 'object'),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
create unique index ird_import_mappings_name on ird_import_mappings (lower(name));

create table ird_imports (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  document_id bigint not null references ird_documents(id),
  sha256 text not null,
  source text not null check (source in ('myir_export', 'other_spreadsheet')),
  supporting_document_id bigint references ird_documents(id),
  mapping jsonb not null,
  mapping_name text,
  file_income_year integer check (file_income_year is null or file_income_year between 2000 and 2100),
  created_by_email text,
  created_at timestamptz not null default now()
);
create unique index ird_imports_sha256 on ird_imports (sha256);

create table ird_import_rows (
  id bigserial primary key,
  import_id bigint not null references ird_imports(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  kind text not null check (kind in ('payment', 'assessment', 'credit', 'interest', 'penalty', 'refund', 'other')),
  income_year integer not null check (income_year between 2000 and 2100),
  transaction_on date not null,
  effective_on date,
  direction text not null check (direction in ('debit', 'credit')),
  amount numeric(18, 2) not null check (amount > 0),
  applies_to text check (applies_to in ('instalment_1', 'instalment_2', 'instalment_3', 'end_of_year')),
  applies_to_text text check (applies_to_text is null or length(applies_to_text) <= 200),
  check (applies_to is null or applies_to_text is not null),
  period_text text check (period_text is null or length(period_text) <= 200),
  description text check (description is null or length(description) <= 500),
  reference text check (reference is null or length(reference) <= 200),
  cells jsonb not null check (jsonb_typeof(cells) = 'array'),
  status text not null default 'waiting' check (status in ('waiting', 'accepted', 'declined')),
  decided_by_email text,
  decided_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  check ((status = 'waiting') = (decided_at is null)),
  check ((status = 'declined') = (decline_reason is not null)),
  outcome text check (outcome is null or length(outcome) <= 500),
  payment_id bigint references income_tax_payments(id) on delete set null,
  allocation_id bigint references income_tax_payment_allocations(id) on delete set null,
  set_assessed_rit boolean not null default false,
  unique (import_id, row_number)
);
create index ird_import_rows_waiting on ird_import_rows (import_id) where status = 'waiting';
create index ird_import_rows_year on ird_import_rows (income_year) where status = 'accepted';
create unique index ird_import_rows_one_payment on ird_import_rows (payment_id) where payment_id is not null;
`,
  };
