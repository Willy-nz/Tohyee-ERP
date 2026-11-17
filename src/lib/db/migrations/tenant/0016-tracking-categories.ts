import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0016",
    name: "tracking_categories",
    sql: `
-- Advanced (ERP) features and tracking categories (examples TC1-TC10):
-- Department, Class and Location, each a tree of values. Document lines and
-- posted journal lines carry one value per category in a jsonb map
-- {"<category id>": "<value id>"}; tags never change amounts or accounts.
alter table organisation_settings add column advanced_features boolean not null default false;

create table tracking_categories (
  id bigserial primary key,
  kind text not null check (kind in ('department', 'class', 'location', 'custom')),
  name text not null check (length(name) between 1 and 60),
  is_required boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tracking_categories_name_idx on tracking_categories (lower(name));
create unique index tracking_categories_kind_idx on tracking_categories (kind) where kind <> 'custom';
insert into tracking_categories (kind, name, sort_order) values
  ('department', 'Department', 1), ('class', 'Class', 2), ('location', 'Location', 3);

create table tracking_values (
  id bigserial primary key,
  category_id bigint not null references tracking_categories(id),
  parent_id bigint references tracking_values(id),
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create unique index tracking_values_sibling_name_idx on tracking_values (category_id, coalesce(parent_id, 0), lower(name));
create index tracking_values_parent_idx on tracking_values (parent_id);

-- A value's parent is in the same category and never one of its own
-- children; values are archived, never deleted.
create function tohyee_guard_tracking_value() returns trigger
language plpgsql as $$
declare
  parent record;
  cursor_id bigint;
  steps integer := 0;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'tracking_values can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tracking values can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.category_id <> old.category_id then
    raise exception 'A tracking value can''t move to another category' using errcode = 'P0001';
  end if;
  if new.parent_id is not null then
    select category_id into parent from tracking_values where id = new.parent_id;
    if parent.category_id is distinct from new.category_id then
      raise exception 'A tracking value''s parent must be in the same category' using errcode = 'P0001';
    end if;
    cursor_id := new.parent_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'A tracking value can''t be under itself or its own children' using errcode = 'P0001';
      end if;
      steps := steps + 1;
      if steps > 50 then
        raise exception 'Tracking values can be at most 50 levels deep' using errcode = 'P0001';
      end if;
      select parent_id into cursor_id from tracking_values where id = cursor_id;
    end loop;
  end if;
  return new;
end;
$$;
create trigger tracking_values_guard
  before insert or update or delete on tracking_values
  for each row execute function tohyee_guard_tracking_value();
create trigger tracking_values_no_truncate
  before truncate on tracking_values
  for each statement execute function tohyee_guard_tracking_value();

create function tohyee_guard_tracking_category() returns trigger
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
  return new;
end;
$$;
create trigger tracking_categories_guard
  before update or delete on tracking_categories
  for each row execute function tohyee_guard_tracking_category();
create trigger tracking_categories_no_truncate
  before truncate on tracking_categories
  for each statement execute function tohyee_guard_tracking_category();

-- Tags on a line: an object of category id -> value id, each value in its category.
create function tohyee_valid_tracking(tags jsonb) returns boolean
language plpgsql stable as $$
declare
  entry record;
begin
  if jsonb_typeof(tags) <> 'object' then
    return false;
  end if;
  for entry in select key, value from jsonb_each(tags) loop
    if jsonb_typeof(entry.value) <> 'string' or entry.key !~ '^[1-9][0-9]{0,17}$' or (entry.value #>> '{}') !~ '^[1-9][0-9]{0,17}$' then
      return false;
    end if;
    if not exists (
      select 1 from tracking_values v where v.id = (entry.value #>> '{}')::bigint and v.category_id = entry.key::bigint
    ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function tohyee_check_line_tracking() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.tracking = old.tracking then
    return new;
  end if;
  if not tohyee_valid_tracking(new.tracking) then
    raise exception 'A line''s tracking tags must each be a value of its category' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

alter table ledger_journal_lines add column tracking jsonb not null default '{}'::jsonb;
alter table sales_invoice_lines add column tracking jsonb not null default '{}'::jsonb;
alter table bill_lines add column tracking jsonb not null default '{}'::jsonb;
alter table sales_credit_note_lines add column tracking jsonb not null default '{}'::jsonb;
alter table supplier_credit_note_lines add column tracking jsonb not null default '{}'::jsonb;
alter table bank_transaction_lines add column tracking jsonb not null default '{}'::jsonb;
create trigger ledger_journal_lines_tracking before insert on ledger_journal_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger sales_invoice_lines_tracking before insert or update on sales_invoice_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger bill_lines_tracking before insert or update on bill_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger sales_credit_note_lines_tracking before insert or update on sales_credit_note_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger supplier_credit_note_lines_tracking before insert or update on supplier_credit_note_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger bank_transaction_lines_tracking before insert or update on bank_transaction_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create index ledger_journal_lines_tracking_idx on ledger_journal_lines using gin (tracking);
`,
  };
