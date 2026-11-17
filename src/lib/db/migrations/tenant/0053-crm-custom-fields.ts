import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0053",
    name: "crm_custom_fields",
    sql: `
-- Custom fields on CRM records (CRMF1-CRMF9): people and opportunities get
-- their own kinds of field, contact fields can be used on prospects, and
-- fields can be grouped into named, ordered sections. Values never change an
-- amount, account, tag, stage or GST box.
alter table custom_fields drop constraint custom_fields_record_check;
alter table custom_fields add constraint custom_fields_record_check
  check (record in ('contact', 'document', 'line', 'person', 'opportunity'));
do $$
declare
  con_name text;
begin
  for con_name in
    select conname from pg_constraint
     where conrelid = 'custom_fields'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%used_on <@%'
  loop
    execute format('alter table custom_fields drop constraint %I', con_name);
  end loop;
end;
$$;
alter table custom_fields add constraint custom_fields_used_on_kind_check check (
  (record = 'contact' and used_on <@ array['customer', 'supplier', 'prospect'])
  or (record in ('document', 'line') and used_on <@ array['invoice', 'bill', 'credit_note', 'supplier_credit_note', 'spend', 'receive', 'journal'])
  or (record = 'person' and used_on <@ array['person'])
  or (record = 'opportunity' and used_on <@ array['opportunity'])
);

-- Existing contact fields stay where they are: prospects only get the fields
-- an admin turns on for them (CRMF3, CRMF11).

create table custom_field_sections (
  id bigserial primary key,
  record text not null check (record in ('contact', 'document', 'person', 'opportunity')),
  name text not null check (length(name) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index custom_field_sections_name_idx on custom_field_sections (record, lower(name));
create trigger custom_field_sections_no_truncate before truncate on custom_field_sections
  for each statement execute function tohyee_guard_custom_field();

alter table custom_fields add column section_id bigint references custom_field_sections(id);
create index custom_fields_section_idx on custom_fields (section_id) where section_id is not null;

-- A field can only be in a section for its own kind of record, and a
-- section's kind never changes.
create function tohyee_check_custom_field_section() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'custom_field_sections' then
    if new.record <> old.record then
      raise exception 'A custom field section''s kind of record can''t change' using errcode = 'P0001';
    end if;
  elsif new.section_id is not null
        and not exists (select 1 from custom_field_sections s where s.id = new.section_id and s.record = new.record) then
    raise exception 'A custom field can only be in a section for its own kind of record' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger custom_fields_section_check before insert or update of section_id, record on custom_fields
  for each row execute function tohyee_check_custom_field_section();
create trigger custom_field_sections_guard before update of record on custom_field_sections
  for each row execute function tohyee_check_custom_field_section();

alter table crm_people add column custom_fields jsonb not null default '{}'::jsonb;
alter table crm_opportunities add column custom_fields jsonb not null default '{}'::jsonb;
create trigger crm_people_custom_fields before insert or update on crm_people
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('person');
create trigger crm_opportunities_custom_fields before insert or update on crm_opportunities
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('opportunity');
`,
  };
