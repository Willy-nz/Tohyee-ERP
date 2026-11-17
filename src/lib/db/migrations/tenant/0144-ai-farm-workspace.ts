import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0144",
    name: "ai_farm_workspace",
    sql: `
-- The AI's farm workspace (#259 follow-up, examples AIW1-AIW8, decision 533).
-- The farm notebook: what people and the AI know about the farm (history,
-- goals, people, how it's farmed), for answering questions.
create table farm_notebook (
  id bigserial primary key,
  category text not null check (category in ('history', 'goals', 'people', 'practices', 'places', 'other')),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 20000),
  happened_on date,
  written_by text not null check (written_by in ('person', 'ai')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index farm_notebook_category on farm_notebook (category, id) where archived_at is null;

-- Files people drop in for the AI to read and organise, however they arrive.
create table ai_files (
  id bigserial primary key,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (length(content_type) between 1 and 100),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  content bytea not null,
  note text check (note is null or length(note) <= 1000),
  uploaded_by_email text not null,
  uploaded_at timestamptz not null default now(),
  archived_at timestamptz
);

-- The AI's own tables: it decides the columns, and fills them from the files,
-- the notebook and the books. Values are kept as text, numbers as exact
-- decimal text, so sums are worked out in numeric, never floats.
create table ai_datasets (
  id bigserial primary key,
  name text not null check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  description text not null check (length(description) between 1 and 2000),
  columns jsonb not null,
  source_note text check (source_note is null or length(source_note) <= 2000),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index ai_datasets_name on ai_datasets (name) where archived_at is null;

create table ai_dataset_rows (
  dataset_id bigint not null references ai_datasets(id),
  row_no integer not null check (row_no > 0),
  data jsonb not null,
  primary key (dataset_id, row_no)
);

-- Dashboards the AI (or a person) lays out over the AI's tables.
create table ai_dashboards (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  tiles jsonb not null,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

-- Livestock movements the AI found in messy data: a person accepts each one
-- (which records the movement as usual) or declines it.
create table livestock_suggestions (
  id bigserial primary key,
  movement jsonb not null,
  evidence text not null check (length(evidence) between 1 and 2000),
  suggested_by_email text not null,
  suggested_at timestamptz not null default now(),
  decision text check (decision is null or decision in ('accepted', 'declined')),
  movement_id bigint references livestock_movements(id),
  decided_by_email text,
  decided_at timestamptz,
  check ((decision is null) = (decided_at is null)),
  check ((decision = 'accepted') = (movement_id is not null))
);
create index livestock_suggestions_open on livestock_suggestions (id) where decision is null;
`,
  };
