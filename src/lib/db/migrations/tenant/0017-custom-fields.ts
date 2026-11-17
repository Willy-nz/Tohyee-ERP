import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0017",
    name: "custom_fields",
    sql: `
-- Custom segments and custom fields (examples CS1-CS3, CF1-CF10). A custom
-- segment is a tracking category of kind 'custom'; any of those can be
-- archived (hidden from new lines). Custom fields hold extra information on
-- contacts, documents and lines that never reaches the ledger. Values are a
-- jsonb map {"<field id>": value}.
alter table tracking_categories add column is_active boolean not null default true;

create or replace function tohyee_guard_tracking_category() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'tracking_categories can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tracking categories can''t be deleted' using errcode = 'P0001';
  end if;
  if new.kind <> old.kind then
    raise exception 'A tracking category''s kind can''t change' using errcode = 'P0001';
  end if;
  if new.kind <> 'custom' and not new.is_active then
    raise exception 'Department, Class and Location can''t be archived' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create table custom_fields (
  id bigserial primary key,
  record text not null check (record in ('contact', 'document', 'line')),
  label text not null check (length(label) between 1 and 60),
  help text check (help is null or length(help) between 1 and 300),
  field_type text not null check (field_type in ('text', 'long_text', 'integer', 'decimal', 'money', 'percent', 'date',
    'checkbox', 'list', 'multi_select', 'email', 'phone', 'url')),
  used_on text[] not null check (cardinality(used_on) >= 1),
  is_required boolean not null default false,
  default_value jsonb,
  show_in_list boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not (is_required and field_type = 'checkbox')),
  check (
    (record = 'contact' and used_on <@ array['customer', 'supplier'])
    or (record <> 'contact' and used_on <@ array['invoice', 'bill', 'credit_note', 'supplier_credit_note', 'spend', 'receive', 'journal'])
  )
);
create unique index custom_fields_label_idx on custom_fields (record, lower(label));

create table custom_field_options (
  id bigserial primary key,
  field_id bigint not null references custom_fields(id),
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index custom_field_options_name_idx on custom_field_options (field_id, lower(name));

-- Fields and options are archived, never deleted; a field's type and what
-- it's on never change.
create function tohyee_guard_custom_field() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Custom fields and their options can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if tg_table_name = 'custom_fields' then
    if new.record <> old.record or new.field_type <> old.field_type then
      raise exception 'A custom field''s type and what it''s on can''t change' using errcode = 'P0001';
    end if;
  elsif new.field_id <> old.field_id then
    raise exception 'An option can''t move to another field' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger custom_fields_guard before update or delete on custom_fields
  for each row execute function tohyee_guard_custom_field();
create trigger custom_fields_no_truncate before truncate on custom_fields
  for each statement execute function tohyee_guard_custom_field();
create trigger custom_field_options_guard before update or delete on custom_field_options
  for each row execute function tohyee_guard_custom_field();
create trigger custom_field_options_no_truncate before truncate on custom_field_options
  for each statement execute function tohyee_guard_custom_field();

-- Values: an object whose keys are fields for this kind of record.
create function tohyee_check_custom_values() returns trigger
language plpgsql as $$
declare
  entry record;
  wanted text := tg_argv[0];
begin
  if tg_op = 'UPDATE' and new.custom_fields = old.custom_fields then
    return new;
  end if;
  if jsonb_typeof(new.custom_fields) <> 'object' then
    raise exception 'Custom field values must be an object' using errcode = 'P0001';
  end if;
  for entry in select key, value from jsonb_each(new.custom_fields) loop
    if entry.key !~ '^[1-9][0-9]{0,17}$'
       or jsonb_typeof(entry.value) not in ('string', 'boolean', 'array')
       or not exists (select 1 from custom_fields f where f.id = entry.key::bigint and f.record = wanted) then
      raise exception 'Custom field values must each belong to a % field', wanted using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;

alter table contacts add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_invoices add column custom_fields jsonb not null default '{}'::jsonb;
alter table bills add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_credit_notes add column custom_fields jsonb not null default '{}'::jsonb;
alter table supplier_credit_notes add column custom_fields jsonb not null default '{}'::jsonb;
alter table bank_transactions add column custom_fields jsonb not null default '{}'::jsonb;
alter table ledger_journals add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_invoice_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table bill_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_credit_note_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table supplier_credit_note_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table bank_transaction_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table ledger_journal_lines add column custom_fields jsonb not null default '{}'::jsonb;

create trigger contacts_custom_fields before insert or update on contacts
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('contact');
create trigger sales_invoices_custom_fields before insert or update on sales_invoices
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger bills_custom_fields before insert or update on bills
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger sales_credit_notes_custom_fields before insert or update on sales_credit_notes
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger supplier_credit_notes_custom_fields before insert or update on supplier_credit_notes
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger bank_transactions_custom_fields before insert or update on bank_transactions
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger ledger_journals_custom_fields before insert on ledger_journals
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger sales_invoice_lines_custom_fields before insert or update on sales_invoice_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger bill_lines_custom_fields before insert or update on bill_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger sales_credit_note_lines_custom_fields before insert or update on sales_credit_note_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger supplier_credit_note_lines_custom_fields before insert or update on supplier_credit_note_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger bank_transaction_lines_custom_fields before insert or update on bank_transaction_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger ledger_journal_lines_custom_fields before insert on ledger_journal_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
`,
  };
