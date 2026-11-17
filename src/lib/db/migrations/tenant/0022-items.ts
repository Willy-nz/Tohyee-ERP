import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0022",
    name: "items",
    sql: `
-- Products and services (examples IT1-IT9), like Xero's items with
-- NetSuite's extras. Every organisation has the item list (service,
-- non-stock and stock items); units of measure, price levels, supplier
-- prices and kits are set while Advanced reporting is on. Items and their
-- units are archived, never deleted. In this step a stock item only records
-- its type: nothing moves stock or posts cost of sales yet.
create table items (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$'),
  name text not null check (length(name) between 1 and 150),
  description text check (description is null or length(description) between 1 and 500),
  item_type text not null check (item_type in ('service', 'non_stock', 'stock', 'kit')),
  base_unit text not null default 'each' check (length(base_unit) between 1 and 30),
  sale_price numeric check (sale_price is null or (sale_price > 0 and scale(sale_price) <= 4)),
  purchase_price numeric check (purchase_price is null or (purchase_price > 0 and scale(purchase_price) <= 4)),
  income_account_id bigint references accounts(id),
  purchase_account_id bigint references accounts(id),
  sales_tax_code_id bigint references tax_codes(id),
  purchase_tax_code_id bigint references tax_codes(id),
  sale_unit_id bigint,
  purchase_unit_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
-- Codes are unique ignoring case, archived items included.
create unique index items_code_idx on items (lower(code));
create trigger items_no_delete before delete on items for each row execute function toeyee_forbid_delete();
create trigger items_no_truncate before truncate on items for each statement execute function toeyee_forbid_delete();

-- Units of measure (IT5): a fixed multiple of the item's base unit, e.g.
-- "Box of 12" = 12 each. The multiple never changes (add a new unit instead),
-- so lines already saved keep their meaning.
create table item_units (
  id bigserial primary key,
  item_id bigint not null references items(id),
  name text not null check (length(name) between 1 and 30),
  factor numeric not null check (factor > 0 and scale(factor) <= 4),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, id)
);
create unique index item_units_name_idx on item_units (item_id, lower(name));
create function tohyee_guard_item_unit() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'item_units can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Units can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if new.factor <> old.factor or new.item_id <> old.item_id then
    raise exception 'A unit''s size can''t change; archive it and add a new unit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger item_units_guard before update or delete on item_units for each row execute function tohyee_guard_item_unit();
create trigger item_units_no_truncate before truncate on item_units for each statement execute function tohyee_guard_item_unit();
alter table items add constraint items_sale_unit_fk foreign key (id, sale_unit_id) references item_units (item_id, id);
alter table items add constraint items_purchase_unit_fk foreign key (id, purchase_unit_id) references item_units (item_id, id);

-- Prices for price levels (IT4): an explicit price overrides the level's
-- percent for this item.
create table item_level_prices (
  item_id bigint not null references items(id),
  price_level_id bigint not null references price_levels(id),
  price numeric not null check (price > 0 and scale(price) <= 4),
  primary key (item_id, price_level_id)
);

-- Supplier prices (IT6): each supplier's price and their code for the item;
-- at most one preferred supplier per item.
create table item_suppliers (
  item_id bigint not null references items(id),
  contact_id bigint not null references contacts(id),
  price numeric check (price is null or (price > 0 and scale(price) <= 4)),
  supplier_item_code text check (supplier_item_code is null or length(supplier_item_code) between 1 and 50),
  is_preferred boolean not null default false,
  primary key (item_id, contact_id)
);
create unique index item_suppliers_preferred_idx on item_suppliers (item_id) where is_preferred;

-- Kits (IT7): a bundle of other items. No kits inside kits.
create table kit_components (
  kit_item_id bigint not null references items(id),
  component_item_id bigint not null references items(id),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  primary key (kit_item_id, component_item_id),
  check (kit_item_id <> component_item_id)
);
create index kit_components_component_idx on kit_components (component_item_id);

create function tohyee_check_kit_component() returns trigger
language plpgsql as $$
begin
  if (select item_type from items where id = new.kit_item_id) <> 'kit' then
    raise exception 'Only a kit can have components' using errcode = 'P0001';
  end if;
  if (select item_type from items where id = new.component_item_id) = 'kit' then
    raise exception 'A kit can''t be inside another kit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger kit_components_check before insert or update on kit_components
  for each row execute function tohyee_check_kit_component();

create function tohyee_check_item_kind() returns trigger
language plpgsql as $$
begin
  if new.item_type = 'kit' and exists (select 1 from kit_components where component_item_id = new.id) then
    raise exception 'This item is part of a kit, so it can''t be a kit itself' using errcode = 'P0001';
  end if;
  if new.item_type <> 'kit' and exists (select 1 from kit_components where kit_item_id = new.id) then
    raise exception 'A kit with components can''t change type; remove its components first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger items_kind_check before update of item_type on items
  for each row execute function tohyee_check_item_kind();

-- Lines of documents can name an item and the unit used; the quantity in
-- the item's base unit is worked out exactly and kept with the line.
alter table sales_invoice_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint sales_invoice_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));
alter table bill_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint bill_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));
alter table sales_credit_note_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint sales_credit_note_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));
alter table supplier_credit_note_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint supplier_credit_note_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));

-- A line's unit belongs to its item, and its base quantity is exactly the
-- quantity times the unit's size (1 for the base unit).
create function tohyee_check_line_item() returns trigger
language plpgsql as $$
declare
  unit_item bigint;
  unit_factor numeric := 1;
begin
  if new.item_id is null then
    return new;
  end if;
  if new.unit_id is not null then
    select item_id, factor into unit_item, unit_factor from item_units where id = new.unit_id;
    if unit_item is distinct from new.item_id then
      raise exception 'A line''s unit must be one of its item''s units' using errcode = 'P0001';
    end if;
  end if;
  if new.base_quantity <> new.quantity * unit_factor then
    raise exception 'A line''s base quantity must be its quantity times its unit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sales_invoice_lines_item before insert or update on sales_invoice_lines
  for each row execute function tohyee_check_line_item();
create trigger bill_lines_item before insert or update on bill_lines
  for each row execute function tohyee_check_line_item();
create trigger sales_credit_note_lines_item before insert or update on sales_credit_note_lines
  for each row execute function tohyee_check_line_item();
create trigger supplier_credit_note_lines_item before insert or update on supplier_credit_note_lines
  for each row execute function tohyee_check_line_item();
`,
  };
