import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0025",
    name: "purchase_orders",
    sql: `
-- Purchase orders (examples PO1-PO9). A draft can be edited and deleted;
-- approving numbers it (PO-0001, no gaps) and locks it. Purchase orders post
-- nothing. "Copy to bill" makes a draft bill whose lines point back to the
-- purchase order's lines; what's billed is worked out from those bills, never
-- stored. An approved purchase order with no bills can be cancelled.

create table purchase_order_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into purchase_order_numbering (id) values (true);
create trigger purchase_order_numbering_guard
  before update or delete on purchase_order_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger purchase_order_numbering_no_truncate
  before truncate on purchase_order_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table purchase_orders (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  contact_id bigint not null references contacts(id),
  order_date date not null,
  delivery_date date,
  delivery_address text check (delivery_address is null or length(delivery_address) between 1 and 500),
  delivery_instructions text check (delivery_instructions is null or length(delivery_instructions) between 1 and 1000),
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  po_sequence integer unique check (po_sequence > 0),
  po_number text unique,
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  cancel_command_source text,
  cancel_idempotency_key text,
  cancel_request_hash text,
  cancelled_by_user_id uuid,
  cancelled_by_email text,
  cancelled_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (cancel_command_source, cancel_idempotency_key),
  check (delivery_date is null or delivery_date >= order_date),
  check (total = subtotal + tax_total),
  check (po_number is null or po_number = 'PO-' || lpad(po_sequence::text, greatest(4, length(po_sequence::text)), '0')),
  check ((status = 'draft') = (po_number is null)),
  check ((status = 'draft') = (approved_at is null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index purchase_orders_status_idx on purchase_orders (status, id);
create index purchase_orders_contact_idx on purchase_orders (contact_id);

create table purchase_order_lines (
  id bigserial primary key,
  purchase_order_id bigint not null references purchase_orders(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  unit_price numeric not null check (unit_price > 0 and scale(unit_price) <= 4),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
  line_amount numeric not null check (line_amount > 0),
  net_amount numeric not null check (net_amount >= 0),
  tax_amount numeric not null check (tax_amount >= 0),
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (purchase_order_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);

-- A draft can be edited and deleted. An approved purchase order is locked:
-- it can only be cancelled, once, and only while it has no bills that
-- aren't voided (PO2, PO7). Its lines are frozen with it.
create function tohyee_guard_purchase_order() returns trigger
language plpgsql as $$
declare
  cancel_columns text[] := array['status', 'cancel_command_source', 'cancel_idempotency_key', 'cancel_request_hash',
    'cancelled_by_user_id', 'cancelled_by_email', 'cancelled_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'purchase_orders can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'cancelled' then
      raise exception 'A draft purchase order can''t be cancelled; delete it instead' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Purchase order % is %, so it can''t be deleted', old.po_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'cancelled'
     and (to_jsonb(new) - cancel_columns) = (to_jsonb(old) - cancel_columns) then
    if exists (select 1 from bills where purchase_order_id = old.id and status <> 'voided') then
      raise exception 'Purchase order % has bills, so it can''t be cancelled', old.po_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Purchase order % is %, so it can''t be changed', old.po_number, old.status using errcode = 'P0001';
end;
$$;
create trigger purchase_orders_guard before update or delete on purchase_orders
  for each row execute function tohyee_guard_purchase_order();
create trigger purchase_orders_no_truncate before truncate on purchase_orders
  for each statement execute function tohyee_guard_purchase_order();

create function tohyee_guard_purchase_order_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'purchase_order_lines can''t be truncated' using errcode = 'P0001';
  end if;
  select status into parent_status from purchase_orders
   where id = case when tg_op = 'DELETE' then old.purchase_order_id else new.purchase_order_id end for share;
  if parent_status <> 'draft' then
    raise exception 'Lines of an approved purchase order can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.purchase_order_id <> new.purchase_order_id then
    raise exception 'A purchase order line can''t move to another purchase order' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger purchase_order_lines_guard before insert or update or delete on purchase_order_lines
  for each row execute function tohyee_guard_purchase_order_line();
create trigger purchase_order_lines_no_truncate before truncate on purchase_order_lines
  for each statement execute function tohyee_guard_purchase_order_line();
create trigger purchase_order_lines_item before insert or update on purchase_order_lines
  for each row execute function tohyee_check_line_item();
create trigger purchase_order_lines_tracking before insert or update on purchase_order_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger purchase_orders_custom_fields before insert or update on purchase_orders
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger purchase_order_lines_custom_fields before insert or update on purchase_order_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- Bills made from a purchase order (PO3-PO6). The bill names it, and each
-- of its lines that came from it names that line.
alter table bills add column purchase_order_id bigint references purchase_orders(id);
create index bills_purchase_order_idx on bills (purchase_order_id) where purchase_order_id is not null;
alter table bill_lines add column purchase_order_line_id bigint references purchase_order_lines(id);
create index bill_lines_purchase_order_line_idx on bill_lines (purchase_order_line_id) where purchase_order_line_id is not null;

-- A bill's purchase order is an approved one from the same supplier, and
-- can't be changed once set.
create function tohyee_check_bill_purchase_order() returns trigger
language plpgsql as $$
declare
  po record;
begin
  if tg_op = 'UPDATE' and new.purchase_order_id is distinct from old.purchase_order_id then
    raise exception 'A bill''s purchase order can''t be changed' using errcode = 'P0001';
  end if;
  if new.purchase_order_id is null then
    return new;
  end if;
  select status, contact_id into po from purchase_orders where id = new.purchase_order_id;
  if po.status <> 'approved' then
    raise exception 'Bills can only be made from an approved purchase order' using errcode = 'P0001';
  end if;
  if po.contact_id <> new.contact_id then
    raise exception 'A bill from a purchase order must be from the purchase order''s supplier' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bills_purchase_order before insert or update on bills
  for each row execute function tohyee_check_bill_purchase_order();

-- A bill line from a purchase order line: that line is on the bill's own
-- purchase order, has the same item and unit, and the bills that aren't
-- voided never add up to more than was ordered (PO6).
create function tohyee_check_bill_line_purchase_order() returns trigger
language plpgsql as $$
declare
  po_line record;
  bill_po bigint;
  on_bills numeric;
begin
  if new.purchase_order_line_id is null then
    return new;
  end if;
  select purchase_order_id, quantity, item_id, unit_id into po_line from purchase_order_lines where id = new.purchase_order_line_id;
  select purchase_order_id into bill_po from bills where id = new.bill_id;
  if bill_po is distinct from po_line.purchase_order_id then
    raise exception 'A bill line can only come from its own bill''s purchase order' using errcode = 'P0001';
  end if;
  if new.item_id is distinct from po_line.item_id or new.unit_id is distinct from po_line.unit_id then
    raise exception 'A bill line from a purchase order keeps its item and unit' using errcode = 'P0001';
  end if;
  select coalesce(sum(l.quantity), 0) into on_bills
    from bill_lines l join bills b on b.id = l.bill_id
   where l.purchase_order_line_id = new.purchase_order_line_id and b.status <> 'voided';
  if on_bills > po_line.quantity then
    raise exception 'Bills can''t add up to more than the purchase order line ordered' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bill_lines_purchase_order after insert or update on bill_lines
  for each row execute function tohyee_check_bill_line_purchase_order();
`,
  };
