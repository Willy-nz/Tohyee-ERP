import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0173",
    name: "group_steward_records",
    sql: `
-- A group's own business records (#200, decisions 641-645; Codex,
-- delegated by owner, 20 October 2026), kept in the database of the member
-- organisation the group names as its steward, not in the core database.
-- group_id is the group's id in the core registry; contact ids are contacts
-- in each member's own database (no names are copied here). Nothing here is
-- posted anywhere.

-- The same customer in several member organisations, linked by a person
-- (never matched automatically by name or email).
create table group_customers (
  id bigserial primary key,
  group_id bigint not null,
  name text not null check (length(name) between 1 and 200 and name = btrim(name)),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((removed_at is null) = (removed_by_email is null))
);
create index group_customers_group on group_customers (group_id) where removed_at is null;

create table group_customer_links (
  id bigserial primary key,
  group_id bigint not null,
  group_customer_id bigint not null references group_customers(id),
  organisation_id text not null,
  contact_id bigint not null,
  linked_by_email text not null,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  unlinked_by_email text,
  check ((unlinked_at is null) = (unlinked_by_email is null))
);
-- A contact is one group customer at a time in a group.
create unique index group_customer_links_once on group_customer_links (group_id, organisation_id, contact_id) where unlinked_at is null;

-- Which group stage each member's opportunity stage counts as, chosen by a person.
create table group_stage_mappings (
  group_id bigint not null,
  organisation_id text not null,
  stage_key text not null,
  group_stage text not null check (length(group_stage) between 1 and 60 and group_stage = btrim(group_stage)),
  mapped_by_email text not null,
  mapped_at timestamptz not null default now(),
  primary key (group_id, organisation_id, stage_key)
);

-- A consolidated report as it was when saved: its figures, the members it
-- used (with their dates) and who saved it. Never changed or deleted.
create table group_report_snapshots (
  id bigserial primary key,
  group_id bigint not null,
  group_name text not null,
  report text not null check (report in ('profit_and_loss', 'balance_sheet')),
  period_from date,
  period_to date not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  member_ids text[] not null check (cardinality(member_ids) >= 1),
  members jsonb not null,
  group_version integer not null,
  body jsonb not null,
  saved_by_user_id uuid,
  saved_by_email text not null,
  saved_at timestamptz not null default now()
);
create index group_report_snapshots_group on group_report_snapshots (group_id, saved_at);
create trigger group_report_snapshots_append_only
  before update or delete on group_report_snapshots
  for each row execute function toeyee_forbid_mutation();
create trigger group_report_snapshots_no_truncate
  before truncate on group_report_snapshots
  for each statement execute function toeyee_forbid_mutation();
`,
  };
