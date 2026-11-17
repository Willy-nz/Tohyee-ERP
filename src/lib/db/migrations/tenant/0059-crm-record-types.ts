import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0059",
    name: "crm_record_types",
    sql: `
-- CRM record types and page layouts (CRM roadmap items 3 and 4, examples
-- CRT1-CRT13), after Salesforce record types and page layouts (NetSuite
-- custom forms): each company (contact), person and opportunity has one
-- record type, and each type has one layout saying which sections and
-- fields its record page shows, in order, and which are required or
-- read-only on that type. One type per kind is the default.
create table crm_record_types (
  id bigserial primary key,
  record text not null check (record in ('contact', 'person', 'opportunity')),
  name text not null check (length(name) between 1 and 60),
  description text check (description is null or length(description) between 1 and 300),
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  layout jsonb not null check (jsonb_typeof(layout) = 'object' and jsonb_typeof(layout -> 'sections') = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_active or not is_default)
);
create unique index crm_record_types_name_idx on crm_record_types (record, lower(name));
create unique index crm_record_types_default_idx on crm_record_types (record) where is_default;

-- Types are never deleted (archive one instead) and stay the kind they were made for.
create function tohyee_guard_crm_record_type() returns trigger
language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Record types are never deleted; archive one instead' using errcode = 'P0001';
  end if;
  if new.record <> old.record then
    raise exception 'A record type''s kind of record can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_record_types_guard before update or delete on crm_record_types
  for each row execute function tohyee_guard_crm_record_type();
create trigger crm_record_types_no_truncate before truncate on crm_record_types
  for each statement execute function tohyee_guard_crm_record_type();

-- The "Standard" type for each kind (CRT1): its standard fields, then its
-- custom fields with no section, then one section per custom field section,
-- then the system fields (read-only).
insert into crm_record_types (record, name, is_default, layout)
select k.record, 'Standard', true,
  jsonb_build_object('sections',
    jsonb_build_array(jsonb_build_object('name', k.first_section, 'fields',
      k.standard || coalesce((select jsonb_agg(jsonb_build_object('key', 'custom:' || f.id, 'required', false, 'readOnly', false) order by f.sort_order, f.id)
                                from custom_fields f where f.record = k.record and f.section_id is null), '[]'::jsonb)))
    || k.extra
    || coalesce((select jsonb_agg(jsonb_build_object(
          'name', case when lower(s.name) = any (k.reserved) then left(s.name, 56) || ' (2)' else s.name end,
          'fields', coalesce((select jsonb_agg(jsonb_build_object('key', 'custom:' || f.id, 'required', false, 'readOnly', false) order by f.sort_order, f.id)
                                from custom_fields f where f.section_id = s.id), '[]'::jsonb))
        order by s.sort_order, s.id)
        from custom_field_sections s where s.record = k.record), '[]'::jsonb)
    || '[{"name": "System information", "fields": [{"key": "createdAt", "required": false, "readOnly": true}, {"key": "updatedAt", "required": false, "readOnly": true}]}]'::jsonb)
from (values
  ('contact', 'Company information',
   '[{"key": "name", "required": true, "readOnly": false}, {"key": "ownerUserId", "required": false, "readOnly": false},
     {"key": "email", "required": false, "readOnly": false}, {"key": "phone", "required": false, "readOnly": false},
     {"key": "gstNumber", "required": false, "readOnly": false}]'::jsonb,
   '[{"name": "Address information", "fields": [{"key": "postalAddress", "required": false, "readOnly": false},
     {"key": "deliveryAddress", "required": false, "readOnly": false}]}]'::jsonb,
   array['company information', 'address information', 'system information']),
  ('person', 'Person information',
   '[{"key": "firstName", "required": true, "readOnly": false}, {"key": "lastName", "required": false, "readOnly": false},
     {"key": "jobTitle", "required": false, "readOnly": false}, {"key": "contactId", "required": false, "readOnly": false},
     {"key": "email", "required": false, "readOnly": false}, {"key": "phone", "required": false, "readOnly": false}]'::jsonb,
   '[]'::jsonb,
   array['person information', 'system information']),
  ('opportunity', 'Opportunity information',
   '[{"key": "name", "required": true, "readOnly": false}, {"key": "contactId", "required": true, "readOnly": false},
     {"key": "pointOfContactId", "required": false, "readOnly": false}, {"key": "ownerUserId", "required": false, "readOnly": false},
     {"key": "amount", "required": false, "readOnly": false}, {"key": "closeDate", "required": false, "readOnly": false},
     {"key": "stage", "required": false, "readOnly": false}]'::jsonb,
   '[]'::jsonb,
   array['opportunity information', 'system information'])
) as k(record, first_section, standard, extra, reserved);

-- A company's owner (after Twenty's account owner and Salesforce's Account
-- Owner): a member of the organisation, kept in the core database.
alter table contacts add column owner_user_id text;

-- Every record has a type; existing ones get the default (CRT1).
alter table contacts add column record_type_id bigint references crm_record_types(id);
alter table crm_people add column record_type_id bigint references crm_record_types(id);
alter table crm_opportunities add column record_type_id bigint references crm_record_types(id);
update contacts set record_type_id = (select id from crm_record_types where record = 'contact' and is_default);
update crm_people set record_type_id = (select id from crm_record_types where record = 'person' and is_default);
update crm_opportunities set record_type_id = (select id from crm_record_types where record = 'opportunity' and is_default);
alter table contacts alter column record_type_id set not null;
alter table crm_people alter column record_type_id set not null;
alter table crm_opportunities alter column record_type_id set not null;
create index contacts_record_type_idx on contacts (record_type_id);
create index crm_people_record_type_idx on crm_people (record_type_id);
create index crm_opportunities_record_type_idx on crm_opportunities (record_type_id);

-- A new record without a type gets its kind's default; a type must be for
-- the record's kind.
create function tohyee_crm_record_type_of() returns trigger
language plpgsql as $$
declare
  kind text := tg_argv[0];
  found text;
begin
  if new.record_type_id is null then
    new.record_type_id := (select id from crm_record_types where record = kind and is_default);
    if new.record_type_id is null then
      raise exception 'There''s no default record type for %', kind using errcode = 'P0001';
    end if;
  else
    found := (select record from crm_record_types where id = new.record_type_id);
    if found is distinct from kind then
      raise exception 'That record type isn''t for this kind of record' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger contacts_record_type before insert or update of record_type_id on contacts
  for each row execute function tohyee_crm_record_type_of('contact');
create trigger crm_people_record_type before insert or update of record_type_id on crm_people
  for each row execute function tohyee_crm_record_type_of('person');
create trigger crm_opportunities_record_type before insert or update of record_type_id on crm_opportunities
  for each row execute function tohyee_crm_record_type_of('opportunity');
`,
  };
