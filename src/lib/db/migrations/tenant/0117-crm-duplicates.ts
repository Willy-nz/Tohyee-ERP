import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0117",
    name: "crm_duplicates",
    sql: `
-- Duplicate companies and people (decision 494, #216). A company with no
-- accounting records can be merged into another: its CRM records move across
-- and it's archived, pointing at the one kept. Two that both have accounting
-- records are only marked as the same customer; the books never change.
alter table contacts add column merged_into_contact_id bigint references contacts(id);
alter table crm_people add column merged_into_person_id bigint references crm_people(id);
alter table contacts add constraint contacts_merged_archived check (merged_into_contact_id is null or is_archived);
alter table crm_people add constraint crm_people_merged_archived check (merged_into_person_id is null or is_archived);

-- What someone decided about a suggested pair: not duplicates, or the same
-- customer kept apart because both have accounting records.
create table crm_duplicate_reviews (
  id bigserial primary key,
  record text not null check (record in ('company', 'person')),
  first_id bigint not null,
  second_id bigint not null,
  decision text not null check (decision in ('not_duplicate', 'same_customer')),
  decided_by_email text,
  decided_at timestamptz not null default now(),
  check (first_id < second_id),
  unique (record, first_id, second_id)
);
`,
  };
